import type { ModelId } from "@dust-tt/types";
import { uuid4 } from "@temporalio/workflow";
import type { drive_v3 } from "googleapis";
import type { GaxiosResponse } from "googleapis-common";
import type { OAuth2Client } from "googleapis-common";
import { GaxiosError } from "googleapis-common";
import StatsD from "hot-shots";
import PQueue from "p-queue";
import { literal, Op } from "sequelize";

import { ensureWebhookForDriveId } from "@connectors/connectors/google_drive/lib";
import { GOOGLE_DRIVE_WEBHOOK_RENEW_MARGIN_MS } from "@connectors/connectors/google_drive/lib/config";
import { getGoogleDriveObject } from "@connectors/connectors/google_drive/lib/google_drive_api";
import { getFileParentsMemoized } from "@connectors/connectors/google_drive/lib/hierarchy";
import { syncOneFile } from "@connectors/connectors/google_drive/temporal/file";
import {
  getMimeTypesToSync,
  isGoogleDriveSpreadSheetFile,
} from "@connectors/connectors/google_drive/temporal/mime_types";
import { deleteSpreadsheet } from "@connectors/connectors/google_drive/temporal/spreadsheets";
import {
  driveObjectToDustType,
  getAuthObject,
  getDocumentId,
  getDriveClient,
  getMyDriveIdCached,
} from "@connectors/connectors/google_drive/temporal/utils";
import { dataSourceConfigFromConnector } from "@connectors/lib/api/data_source_config";
import { deleteFromDataSource } from "@connectors/lib/data_sources";
import { HTTPError } from "@connectors/lib/error";
import { ExternalOauthTokenError } from "@connectors/lib/error";
import {
  GoogleDriveConfig,
  GoogleDriveFiles,
  GoogleDriveFolders,
  GoogleDriveSyncToken,
  GoogleDriveWebhook,
} from "@connectors/lib/models/google_drive";
import { syncFailed } from "@connectors/lib/sync_status";
import { heartbeat } from "@connectors/lib/temporal";
import logger from "@connectors/logger/logger";
import { ConnectorResource } from "@connectors/resources/connector_resource";
import type { DataSourceConfig } from "@connectors/types/data_source_config";
import type { GoogleDriveObjectType } from "@connectors/types/google_drive";
import { FILE_ATTRIBUTES_TO_FETCH } from "@connectors/types/google_drive";

const FILES_SYNC_CONCURRENCY = 10;
const FILES_GC_CONCURRENCY = 5;

type LightGoogledrive = {
  id: string;
  name: string;
  isSharedDrive: boolean;
};

export const statsDClient = new StatsD();

export async function getDrives(
  connectorId: ModelId
): Promise<LightGoogledrive[]> {
  const connector = await ConnectorResource.fetchById(connectorId);
  if (!connector) {
    throw new Error(`Connector ${connectorId} not found`);
  }
  const drive = await getDriveClient(connector.connectionId);

  let nextPageToken: string | undefined | null = undefined;
  const authCredentials = await getAuthObject(connector.connectionId);
  const drives: LightGoogledrive[] = [];
  const myDriveId = await getMyDriveIdCached(authCredentials);
  drives.push({ id: myDriveId, name: "My Drive", isSharedDrive: false });
  do {
    const res: GaxiosResponse<drive_v3.Schema$DriveList> =
      await drive.drives.list({
        pageSize: 100,
        fields: "nextPageToken, drives(id, name)",
        pageToken: nextPageToken,
      });
    if (res.status !== 200) {
      throw new Error(
        `Error getting drives. status_code: ${res.status}. status_text: ${res.statusText}`
      );
    }
    if (!res.data.drives) {
      throw new Error("Drives list is undefined");
    }
    for (const drive of res.data.drives) {
      if (drive.id && drive.name) {
        drives.push({ id: drive.id, name: drive.name, isSharedDrive: true });
      }
    }
    nextPageToken = res.data.nextPageToken;
  } while (nextPageToken);

  return drives;
}

// Get the list of drives that have folders selected for sync.
export async function getDrivesToSync(
  connectorId: ModelId
): Promise<LightGoogledrive[]> {
  const selectedFolders = await GoogleDriveFolders.findAll({
    where: {
      connectorId: connectorId,
    },
  });
  const connector = await ConnectorResource.fetchById(connectorId);
  if (!connector) {
    throw new Error(`Connector ${connectorId} not found`);
  }
  const authCredentials = await getAuthObject(connector.connectionId);
  const drives: Record<string, LightGoogledrive> = {};

  for (const folder of selectedFolders) {
    const remoteFolder = await getGoogleDriveObject(
      authCredentials,
      folder.folderId
    );
    if (remoteFolder) {
      if (!remoteFolder.driveId) {
        throw new Error(`Folder ${folder.folderId} does not have a driveId.`);
      }
      drives[remoteFolder.driveId] = {
        id: remoteFolder.driveId,
        name: remoteFolder.name,
        isSharedDrive: remoteFolder.isInSharedDrive,
      };
    }
  }

  return Object.values(drives);
}

export async function syncFiles(
  connectorId: ModelId,
  dataSourceConfig: DataSourceConfig,
  driveFolderId: string,
  startSyncTs: number,
  nextPageToken?: string
): Promise<{
  nextPageToken: string | null;
  count: number;
  subfolders: string[];
}> {
  const connector = await ConnectorResource.fetchById(connectorId);
  if (!connector) {
    throw new Error(`Connector ${connectorId} not found`);
  }
  const config = await GoogleDriveConfig.findOne({
    where: {
      connectorId: connectorId,
    },
  });
  const mimeTypesToSync = getMimeTypesToSync({
    pdfEnabled: config?.pdfEnabled || false,
  });
  const authCredentials = await getAuthObject(connector.connectionId);
  const driveFolder = await getGoogleDriveObject(
    authCredentials,
    driveFolderId
  );
  if (!driveFolder) {
    // We got a 404 on this folder, we skip it.
    logger.info(
      { driveFolderId },
      `Google Drive Folder unexpectedly not found (got 404)`
    );
    return {
      nextPageToken: null,
      count: 0,
      subfolders: [],
    };
  }
  if (nextPageToken === undefined) {
    // On the first page of a folder id, we can check if we already visited it
    const visitedFolder = await GoogleDriveFiles.findOne({
      where: {
        connectorId: connectorId,
        driveFileId: driveFolder.id,
        lastSeenTs: {
          [Op.gte]: new Date(startSyncTs),
        },
      },
    });
    if (visitedFolder) {
      return { nextPageToken: null, count: 0, subfolders: [] };
    }
  }

  const drive = await getDriveClient(authCredentials);
  const mimeTypesSearchString = mimeTypesToSync
    .map((mimeType) => `mimeType='${mimeType}'`)
    .join(" or ");

  const res = await drive.files.list({
    corpora: "allDrives",
    pageSize: 200,
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
    fields: `nextPageToken, files(${FILE_ATTRIBUTES_TO_FETCH.join(",")})`,
    q: `'${driveFolder.id}' in parents and (${mimeTypesSearchString}) and trashed=false`,
    pageToken: nextPageToken,
  });
  if (res.status !== 200) {
    throw new Error(
      `Error getting files. status_code: ${res.status}. status_text: ${res.statusText}`
    );
  }
  if (!res.data.files) {
    throw new Error("Files list is undefined");
  }
  const filesToSync = await Promise.all(
    res.data.files
      .filter((file) => file.id && file.createdTime)
      .map(async (file) => {
        if (!file.id || !file.createdTime || !file.name || !file.mimeType) {
          throw new Error("Invalid file. File is: " + JSON.stringify(file));
        }
        return driveObjectToDustType(file, authCredentials);
      })
  );
  const subfolders = filesToSync
    .filter((file) => file.mimeType === "application/vnd.google-apps.folder")
    .map((f) => f.id);

  const queue = new PQueue({ concurrency: FILES_SYNC_CONCURRENCY });
  const results = await Promise.all(
    filesToSync.map((file) => {
      return queue.add(async () => {
        if (!file.trashed) {
          return syncOneFile(
            connectorId,
            authCredentials,
            dataSourceConfig,
            file,
            startSyncTs,
            true // isBatchSync
          );
        } else {
          await deleteOneFile(connectorId, file);
        }
      });
    })
  );
  return {
    nextPageToken: res.data.nextPageToken ? res.data.nextPageToken : null,
    count: results.filter((r) => r).length,
    subfolders: subfolders,
  };
}

export async function objectIsInFolders(
  connectorId: ModelId,
  authCredentials: OAuth2Client,
  driveFile: GoogleDriveObjectType,
  foldersIds: string[],
  startSyncTs: number
): Promise<boolean> {
  const parents = await getFileParentsMemoized(
    connectorId,
    authCredentials,
    driveFile,
    startSyncTs
  );
  for (const parent of parents) {
    if (foldersIds.includes(parent.id)) {
      return true;
    }
  }

  return false;
}

export async function incrementalSync(
  connectorId: ModelId,
  dataSourceConfig: DataSourceConfig,
  driveId: string,
  isSharedDrive: boolean,
  startSyncTs: number,
  nextPageToken?: string
): Promise<string | undefined> {
  const localLogger = logger.child({
    provider: "google_drive",
    connectorId: connectorId,
    driveId: driveId,
    activity: "incrementalSync",
    runInstance: uuid4(),
  });
  try {
    const connector = await ConnectorResource.fetchById(connectorId);
    if (!connector) {
      throw new Error(`Connector ${connectorId} not found`);
    }
    if (!nextPageToken) {
      nextPageToken = await getSyncPageToken(
        connectorId,
        driveId,
        isSharedDrive
      );
    }
    const config = await GoogleDriveConfig.findOne({
      where: {
        connectorId: connectorId,
      },
    });
    const mimeTypesToSync = getMimeTypesToSync({
      pdfEnabled: config?.pdfEnabled || false,
    });

    const selectedFoldersIds = await getFoldersToSync(connectorId);

    const authCredentials = await getAuthObject(connector.connectionId);
    const driveClient = await getDriveClient(authCredentials);

    let opts: drive_v3.Params$Resource$Changes$List = {
      pageToken: nextPageToken,
      pageSize: 100,
      fields: "*",
    };
    if (isSharedDrive) {
      opts = {
        ...opts,
        driveId: driveId,
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
      };
    }
    const changesRes: GaxiosResponse<drive_v3.Schema$ChangeList> =
      await driveClient.changes.list(opts);

    if (changesRes.status !== 200) {
      throw new Error(
        `Error getting changes. status_code: ${changesRes.status}. status_text: ${changesRes.statusText}`
      );
    }

    if (changesRes.data.changes === undefined) {
      throw new Error(`changes list is undefined`);
    }

    localLogger.info(
      {
        nbChanges: changesRes.data.changes.length,
      },
      `Got changes.`
    );
    for (const change of changesRes.data.changes) {
      await heartbeat();

      if (change.changeType !== "file" || !change.file) {
        continue;
      }
      if (
        !change.file.mimeType ||
        !mimeTypesToSync.includes(change.file.mimeType)
      ) {
        continue;
      }
      if (!change.file.id) {
        continue;
      }
      const file = await driveObjectToDustType(change.file, authCredentials);
      if (
        !(await objectIsInFolders(
          connectorId,
          authCredentials,
          file,
          selectedFoldersIds,
          startSyncTs
        )) ||
        change.file.trashed
      ) {
        // The current file is not in the list of selected folders.
        // If we have it locally, we need to garbage collect it.
        const localFile = await GoogleDriveFiles.findOne({
          where: {
            connectorId: connectorId,
            driveFileId: change.file.id,
          },
        });
        if (localFile) {
          await deleteOneFile(connectorId, file);
        }
        continue;
      }

      if (!change.file.createdTime || !change.file.name || !change.file.id) {
        throw new Error(
          `Invalid file. File is: ${JSON.stringify(change.file)}`
        );
      }
      localLogger.info({ file_id: change.file.id }, "will sync file");

      const driveFile: GoogleDriveObjectType = await driveObjectToDustType(
        change.file,
        authCredentials
      );
      if (driveFile.mimeType === "application/vnd.google-apps.folder") {
        await GoogleDriveFiles.upsert({
          connectorId: connectorId,
          dustFileId: getDocumentId(driveFile.id),
          driveFileId: file.id,
          name: file.name,
          mimeType: file.mimeType,
          parentId: file.parent,
          lastSeenTs: new Date(),
        });
        localLogger.info({ file_id: change.file.id }, "done syncing file");

        continue;
      }

      await syncOneFile(
        connectorId,
        authCredentials,
        dataSourceConfig,
        driveFile,
        startSyncTs
      );
      localLogger.info({ file_id: change.file.id }, "done syncing file");
    }

    nextPageToken = changesRes.data.nextPageToken
      ? changesRes.data.nextPageToken
      : undefined;
    if (changesRes.data.newStartPageToken) {
      await GoogleDriveSyncToken.upsert({
        connectorId: connectorId,
        driveId: driveId,
        syncToken: changesRes.data.newStartPageToken,
      });
    }

    return nextPageToken;
  } catch (e) {
    if (e instanceof GaxiosError && e.response?.status === 403) {
      localLogger.error(
        {
          error: e.message,
        },
        `Looks like we lost access to this drive. Skipping`
      );
      return undefined;
    } else {
      throw e;
    }
  }
}

export async function getSyncPageToken(
  connectorId: ModelId,
  driveId: string,
  isSharedDrive: boolean
) {
  const connector = await ConnectorResource.fetchById(connectorId);
  if (!connector) {
    throw new Error(`Connector ${connectorId} not found`);
  }
  const last = await GoogleDriveSyncToken.findOne({
    where: {
      connectorId: connectorId,
      driveId: driveId,
    },
  });
  if (last) {
    return last.syncToken;
  }
  const driveClient = await getDriveClient(connector.connectionId);
  let lastSyncToken = undefined;
  if (!lastSyncToken) {
    let opts = {};
    if (isSharedDrive) {
      opts = {
        driveId: driveId,
        supportsAllDrives: true,
      };
    }
    const startTokenRes = await driveClient.changes.getStartPageToken(opts);
    if (startTokenRes.status !== 200) {
      throw new Error(
        `Error getting start page token. status_code: ${startTokenRes.status}. status_text: ${startTokenRes.statusText}`
      );
    }
    if (!startTokenRes.data.startPageToken) {
      throw new Error("No start page token found");
    }
    lastSyncToken = startTokenRes.data.startPageToken;
  }

  return lastSyncToken;
}

export async function getFoldersToSync(connectorId: ModelId) {
  const folders = await GoogleDriveFolders.findAll({
    where: {
      connectorId: connectorId,
    },
  });

  const foldersIds = folders.map((f) => f.folderId);

  return foldersIds;
}

// Check if we still have access to all the selected folder we are
// supposed to sync.
// If we don't have access to one of them, we should garbage collect.
export async function shouldGarbageCollect(connectorId: ModelId) {
  const selectedFolder = await GoogleDriveFolders.findAll({
    where: {
      connectorId: connectorId,
    },
  });
  const connector = await ConnectorResource.fetchById(connectorId);
  if (!connector) {
    throw new Error(`Connector ${connectorId} not found`);
  }

  const authCredentials = await getAuthObject(connector.connectionId);
  for (const folder of selectedFolder) {
    const remoteFolder = await getGoogleDriveObject(
      authCredentials,
      folder.folderId
    );
    if (!remoteFolder) {
      return true;
    }
  }

  return false;
}

/**
 * @param lastSeenTs Garbage collect all files that have not been seen since this timestamp.
 */
export async function garbageCollector(
  connectorId: ModelId,
  lastSeenTs: number
): Promise<number> {
  const connector = await ConnectorResource.fetchById(connectorId);
  if (!connector) {
    throw new Error(`Connector ${connectorId} not found`);
  }

  const authCredentials = await getAuthObject(connector.connectionId);
  const files = await GoogleDriveFiles.findAll({
    where: {
      connectorId: connectorId,
      lastSeenTs: { [Op.or]: [{ [Op.lt]: new Date(lastSeenTs) }, null] },
    },
    limit: 100,
  });

  const queue = new PQueue({ concurrency: FILES_GC_CONCURRENCY });
  const selectedFolders = await getFoldersToSync(connectorId);
  await Promise.all(
    files.map(async (file) => {
      return queue.add(async () => {
        const driveFile = await getGoogleDriveObject(
          authCredentials,
          file.driveFileId
        );
        if (!driveFile) {
          // Could not find the file on Gdrive, deleting our local reference to it.
          await deleteFile(file);
          return null;
        }
        const isInFolder = await objectIsInFolders(
          connectorId,
          authCredentials,
          driveFile,
          selectedFolders,
          lastSeenTs
        );
        if (isInFolder === false || driveFile.trashed) {
          await deleteOneFile(connectorId, driveFile);
        } else {
          await file.update({
            lastSeenTs: new Date(),
          });
        }
      });
    })
  );

  return files.length;
}

export async function renewWebhooks(pageSize: number): Promise<number> {
  // Find webhook that are about to expire in the next hour.
  const webhooks = await GoogleDriveWebhook.findAll({
    where: {
      renewAt: {
        [Op.lt]: new Date(
          new Date().getTime() + GOOGLE_DRIVE_WEBHOOK_RENEW_MARGIN_MS
        ),
      },

      renewedByWebhookId: null,
    },
    limit: pageSize,
  });
  logger.info({ count: webhooks.length }, `Renewing webhooks`);

  for (const wh of webhooks) {
    const connector = await ConnectorResource.fetchById(wh.connectorId);
    if (!connector) {
      logger.error(
        {
          connectorId: wh.connectorId,
          // We want to panic because this code branch is unexpected.
          panic: true,
        },
        `Connector not found for webhook`
      );
      continue;
    }
    if (wh.expiresAt < new Date()) {
      logger.error(
        {
          webhook: {
            id: wh.id,
            expiresAt: wh.expiresAt,
            renewAt: wh.renewAt,
            renewedByWebhookId: wh.renewedByWebhookId,
          },
          connectorId: wh.connectorId,
          workspaceId: connector.workspaceId,
        },
        `We are processing a webhook which have already expired, this should never happen. Investigation needed.`
      );
    }
    try {
      const auth = await getAuthObject(connector.connectionId);
      const remoteDrive = await getGoogleDriveObject(auth, wh.driveId);
      // Check if we still have access to this drive.
      if (!remoteDrive) {
        logger.info(
          { driveId: wh.driveId, connectorId: connector.id },
          `We lost access to the drive. Deleting the associated webhook.`
        );
        await wh.destroy();
        continue;
      }
      const res = await ensureWebhookForDriveId(
        connector,
        wh.driveId,
        GOOGLE_DRIVE_WEBHOOK_RENEW_MARGIN_MS
      );
      if (res.isErr()) {
        // Throwing here to centralize error handling in the catch block
        // below.
        throw res.error;
      }
      if (res.value) {
        // marking the previous webhook as renewed by the new one.
        await wh.update({
          renewedByWebhookId: res.value,
        });
      } else {
        logger.error(
          {
            webhook: {
              id: wh.id,
              connectorId: wh.connectorId,
              workspaceId: connector.workspaceId,
              expiresAt: wh.expiresAt,
              renewAt: wh.renewAt,
              renewedByWebhookId: wh.renewedByWebhookId,
            },
            connectorId: wh.connectorId,
            workspaceId: connector.workspaceId,
            // We want to panic because this code branch is unexpected.
            panic: true,
          },
          `Found a webhook to renew but did not proceed to the renewal process. Need to investigate.`
        );
      }
    } catch (e) {
      if (
        e instanceof ExternalOauthTokenError ||
        (e instanceof HTTPError &&
          e.message === "The caller does not have permission")
      ) {
        await syncFailed(connector.id, "oauth_token_revoked");
        logger.error(
          {
            error: e,
            connectorId: wh.connectorId,
            workspaceId: connector.workspaceId,
          },
          `Failed to renew webhook: Oauth token revoked .`
        );
        // Do not delete the webhook object but push it down the line in 2h so that it does not get
        // picked up by the loop calling rewnewOneWebhook.
        await wh.update({
          renewAt: literal("NOW() + INTERVAL '2 hour'"),
        });
      } else {
        logger.error(
          {
            error: e,
            connectorId: wh.connectorId,
            workspaceId: connector.workspaceId,
          },
          `Failed to renew webhook`
        );
        const tags = [
          `connector_id:${wh.connectorId}`,
          `workspaceId:${connector.workspaceId}`,
        ];
        statsDClient.increment(
          "google_drive_renew_webhook_errors.count",
          1,
          tags
        );
        // Do not delete the webhook object but push it down the line in 2h so that it does not get
        // picked up by the loop calling rewnewOneWebhook.
        await wh.update({
          renewAt: literal("NOW() + INTERVAL '2 hour'"),
        });
      }
    }
  }
  // Clean up webhooks pointers that expired more than 1 day ago.
  // We only clean up webhooks that have been renewed, otherwise they should be taken care of
  // by the renewWebhooks function.
  await GoogleDriveWebhook.destroy({
    where: {
      expiresAt: {
        [Op.lt]: literal("now() - INTERVAL '3 day'"),
      },
      renewedByWebhookId: {
        [Op.not]: null,
      },
    },
    limit: pageSize,
  });
  return webhooks.length;
}

export async function populateSyncTokens(connectorId: ModelId) {
  const connector = await ConnectorResource.fetchById(connectorId);
  if (!connector) {
    throw new Error(`Connector ${connectorId} not found`);
  }
  const drivesIds = await getDrives(connector.id);
  for (const drive of drivesIds) {
    const lastSyncToken = await getSyncPageToken(
      connectorId,
      drive.id,
      drive.isSharedDrive
    );
    await GoogleDriveSyncToken.upsert({
      connectorId: connectorId,
      driveId: drive.id,
      syncToken: lastSyncToken,
    });
  }
}

export async function garbageCollectorFinished(connectorId: ModelId) {
  const connector = await ConnectorResource.fetchById(connectorId);
  if (!connector) {
    throw new Error(`Connector ${connectorId} not found`);
  }

  await connector.update({ lastGCTime: new Date() });
}

export async function getLastGCTime(connectorId: ModelId): Promise<number> {
  const connector = await ConnectorResource.fetchById(connectorId);
  if (!connector) {
    throw new Error(`Connector ${connectorId} not found`);
  }
  return connector.lastGCTime?.getTime() || 0;
}

async function deleteOneFile(
  connectorId: ModelId,
  file: GoogleDriveObjectType
) {
  const googleDriveFile = await GoogleDriveFiles.findOne({
    where: {
      connectorId: connectorId,
      driveFileId: file.id,
    },
  });
  // Only clean up files that we were syncing
  if (!googleDriveFile) {
    return;
  }
  await deleteFile(googleDriveFile);
}

async function deleteFile(googleDriveFile: GoogleDriveFiles) {
  const connectorId = googleDriveFile.connectorId;
  const connector = await ConnectorResource.fetchById(connectorId);
  if (!connector) {
    throw new Error(`Connector ${connectorId} not found`);
  }
  logger.info(
    {
      driveFileId: googleDriveFile.driveFileId,
      connectorId,
    },
    `Deleting Google Drive file.`
  );

  if (isGoogleDriveSpreadSheetFile(googleDriveFile)) {
    await deleteSpreadsheet(connector, googleDriveFile);
  } else if (
    googleDriveFile.mimeType !== "application/vnd.google-apps.folder"
  ) {
    const dataSourceConfig = dataSourceConfigFromConnector(connector);
    await deleteFromDataSource(dataSourceConfig, googleDriveFile.dustFileId);
  }
  await googleDriveFile.destroy();
}

export async function markFolderAsVisited(
  connectorId: ModelId,
  driveFileId: string
) {
  const connector = await ConnectorResource.fetchById(connectorId);
  if (!connector) {
    throw new Error(`Connector ${connectorId} not found`);
  }
  const authCredentials = await getAuthObject(connector.connectionId);
  const file = await getGoogleDriveObject(authCredentials, driveFileId);

  if (!file) {
    logger.info(
      { driveFileId },
      `Google Drive File unexpectedly not found (got 404)`
    );
    // We got a 404 on this folder, we skip it.
    return;
  }

  await GoogleDriveFiles.upsert({
    connectorId: connectorId,
    dustFileId: getDocumentId(driveFileId),
    driveFileId: file.id,
    name: file.name,
    mimeType: file.mimeType,
    parentId: file.parent,
    lastSeenTs: new Date(),
  });
}

export async function folderHasChildren(
  connectorId: ModelId,
  folderId: string
): Promise<boolean> {
  const connector = await ConnectorResource.fetchById(connectorId);
  if (!connector) {
    throw new Error(`Connector ${connectorId} not found`);
  }

  const drive = await getDriveClient(connector.connectionId);
  const res = await drive.files.list({
    corpora: "allDrives",
    pageSize: 1,
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
    fields: "nextPageToken, files(id)",
    q: `'${folderId}' in parents and mimeType='application/vnd.google-apps.folder'`,
  });
  if (!res.data.files) {
    return false;
  }

  return res.data.files?.length > 0;
}
