import { removeNulls } from "@dust-tt/types";
import * as _ from "lodash";

import { renderUserType } from "@app/lib/api/user";
import { subscriptionForWorkspaces } from "@app/lib/auth";
import { User } from "@app/lib/models/user";
import { Workspace } from "@app/lib/models/workspace";
import { FREE_TEST_PLAN_CODE } from "@app/lib/plans/plan_codes";
import { MembershipResource } from "@app/lib/resources/membership_resource";
import { CustomerioServerSideTracking } from "@app/lib/tracking/customerio/server";
import { renderLightWorkspaceType } from "@app/lib/workspace";
import logger from "@app/logger/logger";
import { makeScript } from "@app/scripts/helpers";

const backfillCustomerIo = async (execute: boolean) => {
  const allUserModels = await User.findAll();
  const users = allUserModels.map((u) => renderUserType(u));
  const chunks = _.chunk(users, 16);
  const deletedWorkspaceSids = new Set<string>();
  for (const [i, c] of chunks.entries()) {
    logger.info(
      `[execute=${execute}] Processing chunk of ${c.length} users... (${
        i + 1
      }/${chunks.length})`
    );
    const membershipsByUserId = _.groupBy(
      await MembershipResource.getLatestMemberships({
        users: c,
      }),
      (m) => m.userId.toString()
    );

    const workspaceIds = Object.values(membershipsByUserId)
      .flat()
      .map((m) => m.workspaceId);
    const workspaceById = _.keyBy(
      workspaceIds.length
        ? await Workspace.findAll({
            where: {
              id: workspaceIds,
            },
          })
        : [],
      (ws) => ws.id.toString()
    );

    const workspaceSids = Object.values(workspaceById).map((ws) => ws.sId);
    const subscriptionByWorkspaceSid = workspaceSids.length
      ? await subscriptionForWorkspaces(workspaceSids)
      : {};

    const promises: Promise<unknown>[] = [];
    for (const u of c) {
      const memberships = membershipsByUserId[u.id.toString()] ?? [];
      const workspaces =
        memberships.map((m) => workspaceById[m.workspaceId.toString()]) ?? [];
      const subscriptions =
        removeNulls(
          workspaces.map((ws) => subscriptionByWorkspaceSid[ws.sId])
        ) ?? [];

      if (!subscriptions.some((s) => s.plan.code !== FREE_TEST_PLAN_CODE)) {
        logger.info(
          { userId: u.sId },
          "User does not have any real subscriptions, deleting from Customer.io"
        );

        if (execute) {
          promises.push(
            CustomerioServerSideTracking._deleteUser({
              user: u,
            }).catch((err) => {
              logger.error(
                { userId: u.sId, err },
                "Failed to delete user on Customer.io"
              );
            })
          );
        }
      }

      const workspacesWithoutRealSubscriptions = workspaces.filter((ws) => {
        const subscription = subscriptionByWorkspaceSid[ws.sId];
        return !subscription || subscription.plan.code === FREE_TEST_PLAN_CODE;
      });
      for (const ws of workspacesWithoutRealSubscriptions) {
        if (!deletedWorkspaceSids.has(ws.sId)) {
          logger.info(
            { workspaceId: ws.sId },
            "Workspace does not have a real subscription, deleting from Customer.io"
          );
          if (execute) {
            promises.push(
              CustomerioServerSideTracking._deleteWorkspace({
                workspace: renderLightWorkspaceType({ workspace: ws }),
              }).catch((err) => {
                logger.error(
                  { workspaceId: ws.sId, err },
                  "Failed to delete workspace on Customer.io"
                );
              })
            );
          }
          deletedWorkspaceSids.add(ws.sId);
        }
      }
    }

    if (execute) {
      await Promise.all(promises);
    }
  }
};

makeScript({}, async ({ execute }) => {
  await backfillCustomerIo(execute);
});
