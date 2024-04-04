import { format } from "date-fns/format";
import { Op, QueryTypes } from "sequelize";

import type { Workspace } from "@app/lib/models";
import { AgentConfiguration, Conversation, DataSource } from "@app/lib/models";

import { frontSequelize } from "./resources/storage";

export interface WorkpsaceUsageQueryResult {
  createdAt: string;
  conversationModelId: string;
  messageId: string;
  userMessageId: string;
  agentMessageId: string;
  userId: string;
  userFirstName: string;
  userLastName: string;
  assistantId: string;
  assistantName: string;
  actionType: string;
  source: string;
}

export async function unsafeGetUsageData(
  startDate: Date,
  endDate: Date,
  wId: string
): Promise<string> {
  const results = await frontSequelize.query<WorkpsaceUsageQueryResult>(
    `
      SELECT
        TO_CHAR(m."createdAt"::timestamp, 'YYYY-MM-DD HH24:MI:SS') AS "createdAt",
        c."id" AS "conversationInternalId",
        m."sId" AS "messageId",
        p."sId" AS "parentMessageId",
        CASE
          WHEN um."id" IS NOT NULL THEN 'user'
          WHEN am."id" IS NOT NULL THEN 'assistant'
          WHEN cf."id" IS NOT NULL THEN 'content_fragment'
        END AS "messageType",
        um."userContextFullName" AS "userFullName",
        um."userContextEmail" AS "userEmail",
        COALESCE(ac."sId", am."agentConfigurationId") AS "assistantId",
        COALESCE(ac."name", am."agentConfigurationId") AS "assistantName",
        CASE
            WHEN ac."retrievalConfigurationId" IS NOT NULL THEN 'retrieval'
            WHEN ac."dustAppRunConfigurationId" IS NOT NULL THEN 'dustAppRun'
            ELSE NULL
        END AS "actionType",
        CASE
            WHEN um."id" IS NOT NULL THEN
                CASE
                    WHEN um."userId" IS NOT NULL THEN 'web'
                    ELSE 'slack'
                END
        END AS "source"
    FROM
        "messages" m
    JOIN
        "conversations" c ON m."conversationId" = c."id"
    JOIN
        "workspaces" w ON c."workspaceId" = w."id"
    LEFT JOIN
        "user_messages" um ON m."userMessageId" = um."id"
    LEFT JOIN
        "users" u ON um."userId" = u."id"
    LEFT JOIN
        "agent_messages" am ON m."agentMessageId" = am."id"
    LEFT JOIN
        "content_fragments" cf ON m."contentFragmentId" = cf."id"
    LEFT JOIN
        "agent_configurations" ac ON am."agentConfigurationId" = ac."sId" AND am."agentConfigurationVersion" = ac."version"
    LEFT JOIN
        "messages" p ON m."parentId" = p."id"
    WHERE
        w."sId" = :wId AND
        m."createdAt" >= :startDate AND m."createdAt" <= :endDate
    ORDER BY
        m."createdAt" DESC
    `,
    {
      replacements: {
        wId,
        startDate: format(startDate, "yyyy-MM-dd"), // Use first day of start month
        endDate: format(endDate, "yyyy-MM-dd"), // Use last day of end month
      },
      type: QueryTypes.SELECT,
    }
  );
  if (!results.length) {
    return "No data available for the selected period.";
  }
  const csvHeader = Object.keys(results[0]).join(",") + "\n";
  const csvContent = results
    .map((row) => Object.values(row).join(","))
    .join("\n");

  return csvHeader + csvContent;
}

/**
 * Check if a workspace is active during a trial based on the following conditions:
 *   - Existence of a connected data source
 *   - Existence of a custom assistant
 *   - A conversation occurred within the past 7 days
 */
export async function checkWorkspaceActivity(workspace: Workspace) {
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const hasDataSource = await DataSource.findOne({
    where: { workspaceId: workspace.id },
  });

  const hasCreatedAssistant = await AgentConfiguration.findOne({
    where: { workspaceId: workspace.id },
  });

  const hasRecentConversation = await Conversation.findOne({
    where: { workspaceId: workspace.id, updatedAt: { [Op.gte]: sevenDaysAgo } },
  });

  return hasDataSource || hasCreatedAssistant || hasRecentConversation;
}
