import type {
  FunctionCallType,
  FunctionMessageTypeModel,
  ModelId,
  ModelMessageType,
  RetrievalErrorEvent,
  RetrievalParamsEvent,
  RetrievalSuccessEvent,
} from "@dust-tt/types";
import type {
  RetrievalActionType,
  RetrievalConfigurationType,
  RetrievalDocumentType,
  TimeFrame,
} from "@dust-tt/types";
import type {
  AgentActionSpecification,
  AgentConfigurationType,
} from "@dust-tt/types";
import type { AgentMessageType, ConversationType } from "@dust-tt/types";
import type { Result } from "@dust-tt/types";
import {
  BaseAction,
  cloneBaseConfig,
  DustProdActionRegistry,
} from "@dust-tt/types";
import { Ok } from "@dust-tt/types";

import { runActionStreamed } from "@app/lib/actions/server";
import { getSupportedModelConfig } from "@app/lib/assistant";
import type { Authenticator } from "@app/lib/auth";
import {
  isDevelopment,
  PRODUCTION_DUST_WORKSPACE_ID,
} from "@app/lib/development";
import {
  AgentRetrievalAction,
  RetrievalDocument,
  RetrievalDocumentChunk,
} from "@app/lib/models/assistant/actions/retrieval";
import { frontSequelize } from "@app/lib/resources/storage";
import { rand } from "@app/lib/utils/seeded_random";
import logger from "@app/logger/logger";

/**
 * TimeFrame parsing
 */

// Attempts to parse a string representation of the time frame of the form `{k}{unit}` or `all`
// where {k} is a number and {unit} is one of `d`, `w`, `m`, `y` for day, week, month, year.
export function parseTimeFrame(raw: string): TimeFrame | null {
  const r = raw.trim().toLowerCase();
  if (r === "all") {
    return null;
  }

  const m = r.match(/^(\d+)([hdwmy])$/);
  if (!m) {
    return null;
  }

  const duration = parseInt(m[1], 10);
  if (isNaN(duration)) {
    return null;
  }

  let unit: TimeFrame["unit"];
  switch (m[2]) {
    case "h":
      unit = "hour";
      break;
    case "d":
      unit = "day";
      break;
    case "w":
      unit = "week";
      break;
    case "m":
      unit = "month";
      break;
    case "y":
      unit = "year";
      break;
    default:
      return null;
  }

  return {
    duration,
    unit,
  };
}

// Turns a TimeFrame into a number of milliseconds from now.
export function timeFrameFromNow(timeFrame: TimeFrame): number {
  const now = Date.now();

  switch (timeFrame.unit) {
    case "hour":
      return now - timeFrame.duration * 60 * 60 * 1000;
    case "day":
      return now - timeFrame.duration * 24 * 60 * 60 * 1000;
    case "week":
      return now - timeFrame.duration * 7 * 24 * 60 * 60 * 1000;
    case "month":
      return now - timeFrame.duration * 30 * 24 * 60 * 60 * 1000;
    case "year":
      return now - timeFrame.duration * 365 * 24 * 60 * 60 * 1000;
    default:
      ((x: never) => {
        throw new Error(`Unexpected time frame unit ${x}`);
      })(timeFrame.unit);
  }
}

interface RetrievalActionBlob {
  id: ModelId; // AgentRetrievalAction.
  agentMessageId: ModelId;
  params: {
    relativeTimeFrame: TimeFrame | null;
    query: string | null;
    topK: number;
  };
  functionCallId: string | null;
  functionCallName: string | null;
  documents: RetrievalDocumentType[] | null;
  step: number;
}

export class RetrievalAction extends BaseAction {
  readonly agentMessageId: ModelId;
  readonly params: {
    relativeTimeFrame: TimeFrame | null;
    query: string | null;
    topK: number;
  };
  readonly functionCallId: string | null;
  readonly functionCallName: string | null;
  readonly documents: RetrievalDocumentType[] | null;
  readonly step: number;

  constructor(blob: RetrievalActionBlob) {
    super(blob.id, "retrieval_action");

    this.agentMessageId = blob.agentMessageId;
    this.params = blob.params;
    this.documents = blob.documents;
    this.functionCallId = blob.functionCallId;
    this.functionCallName = blob.functionCallName;
    this.step = blob.step;
  }

  renderForModel(): ModelMessageType {
    let content = "";
    if (!this.documents) {
      content += "(retrieval failed)\n";
    } else {
      for (const d of this.documents) {
        let title = d.documentId;
        for (const t of d.tags) {
          if (t.startsWith("title:")) {
            title = t.substring(6);
            break;
          }
        }

        let dataSourceName = d.dataSourceId;
        if (d.dataSourceId.startsWith("managed-")) {
          dataSourceName = d.dataSourceId.substring(8);
        }

        content += `TITLE: ${title} (data source: ${dataSourceName})\n`;
        content += `REFERENCE: ${d.reference}\n`;
        content += `EXTRACTS:\n`;
        for (const c of d.chunks) {
          content += `${c.text}\n`;
        }
        content += "\n";
      }
    }

    return {
      role: "action" as const,
      name: this.functionCallName ?? "search_data_sources",
      content,
    };
  }

  renderForFunctionCall(): FunctionCallType {
    const timeFrame = this.params.relativeTimeFrame;
    const params = {
      query: this.params.query,
      relativeTimeFrame: timeFrame
        ? `${timeFrame.duration}${timeFrame.unit}`
        : "all",
      topK: this.params.topK,
    };

    return {
      id: this.functionCallId ?? `call_${this.id.toString()}`,
      name: this.functionCallName ?? "search_data_sources",
      arguments: JSON.stringify(params),
    };
  }

  renderForMultiActionsModel(): FunctionMessageTypeModel {
    let content = "";
    if (!this.documents) {
      content += "(retrieval failed)\n";
    } else {
      for (const d of this.documents) {
        let title = d.documentId;
        for (const t of d.tags) {
          if (t.startsWith("title:")) {
            title = t.substring(6);
            break;
          }
        }

        let dataSourceName = d.dataSourceId;
        if (d.dataSourceId.startsWith("managed-")) {
          dataSourceName = d.dataSourceId.substring(8);
        }

        content += `TITLE: ${title} (data source: ${dataSourceName})\n`;
        content += `REFERENCE: ${d.reference}\n`;
        content += `EXTRACTS:\n`;
        for (const c of d.chunks) {
          content += `${c.text}\n`;
        }
        content += "\n";
      }
    }

    return {
      role: "function" as const,
      function_call_id: this.functionCallId ?? `call_${this.id.toString()}`,
      content,
    };
  }
}

/**
 * Params generation.
 */

export function retrievalAutoQueryInputSpecification() {
  return {
    name: "query",
    description:
      "The string used to retrieve relevant chunks of information using semantic similarity" +
      " based on the user request and conversation context." +
      " Include as much semantic signal based on the entire conversation history," +
      " paraphrasing if necessary. longer queries are generally better.",
    type: "string" as const,
  };
}

export function retrievalAutoTimeFrameInputSpecification() {
  return {
    name: "relativeTimeFrame",
    description:
      "The time frame (relative to LOCAL_TIME) to restrict the search based" +
      " on the user request and past conversation context." +
      " Possible values are: `all`, `{k}h`, `{k}d`, `{k}w`, `{k}m`, `{k}y`" +
      " where {k} is a number. Be strict, do not invent invalid values.",
    type: "string" as const,
  };
}

function retrievalActionSpecification({
  actionConfiguration,
  name,
  description,
}: {
  actionConfiguration: RetrievalConfigurationType;
  name: string;
  description: string;
}): AgentActionSpecification {
  const inputs = [];

  if (actionConfiguration.query === "auto") {
    inputs.push(retrievalAutoQueryInputSpecification());
  }
  if (actionConfiguration.relativeTimeFrame === "auto") {
    inputs.push(retrievalAutoTimeFrameInputSpecification());
  }

  return {
    name,
    description,
    inputs,
  };
}

// This is deprecated and should only be used when running agents in "single action mode" (in legacy_agent.ts).
export async function deprecatedGenerateRetrievalSpecificationForSingleActionAgent(
  auth: Authenticator,
  {
    actionConfiguration,
  }: {
    actionConfiguration: RetrievalConfigurationType;
  }
): Promise<Result<AgentActionSpecification, Error>> {
  const owner = auth.workspace();
  if (!owner) {
    throw new Error("Unexpected unauthenticated call to `runRetrieval`");
  }

  const spec = retrievalActionSpecification({
    actionConfiguration,
    name: "search_data_sources",
    description:
      "Search the data sources specified by the user." +
      " The search is based on semantic similarity between the query and chunks of information" +
      " from the data sources.",
  });
  return new Ok(spec);
}

// Generates the action specification for generation of rawInputs passed to `runRetrieval`.
export async function generateRetrievalSpecification(
  auth: Authenticator,
  {
    actionConfiguration,
    name,
    description,
  }: {
    name: string;
    description: string;
    actionConfiguration: RetrievalConfigurationType;
  }
): Promise<Result<AgentActionSpecification, Error>> {
  const owner = auth.workspace();
  if (!owner) {
    throw new Error("Unexpected unauthenticated call to `runRetrieval`");
  }

  const baseDescription = (() => {
    if (actionConfiguration.query === "auto") {
      return (
        "Search the data sources specified by the user." +
        " The search is based on semantic similarity between the query and chunks of information" +
        " from the data sources."
      );
    } else {
      let description =
        "Retrieve the most recent content from the data sources specified by the user";
      if (
        actionConfiguration.relativeTimeFrame === "auto" ||
        actionConfiguration.relativeTimeFrame === "none"
      ) {
        return `${description}.`;
      }
      const timeFrame = actionConfiguration.relativeTimeFrame;
      const plural = timeFrame.duration > 1 ? "s" : "";
      description += ` over the last ${timeFrame.duration} ${timeFrame.unit}${plural}.`;
      return description;
    }
  })();

  const actionDescription = `${baseDescription}\nDescription of the data sources:\n${description}`;

  const spec = retrievalActionSpecification({
    actionConfiguration,
    name,
    description: actionDescription,
  });

  return new Ok(spec);
}

/**
 * Action rendering.
 */

// Internal interface for the retrieval and rendering of a actions from AgentMessage ModelIds. This
// should not be used outside of api/assistant. We allow a ModelId interface here because for
// optimization purposes to avoid duplicating DB requests while having clear action specific code.
export async function retrievalActionTypesFromAgentMessageIds(
  agentMessageIds: ModelId[]
): Promise<RetrievalActionType[]> {
  const models = await AgentRetrievalAction.findAll({
    where: {
      agentMessageId: agentMessageIds,
    },
  });

  const actionById = models.reduce<{
    [id: ModelId]: AgentRetrievalAction;
  }>((acc, a) => {
    acc[a.id] = a;
    return acc;
  }, {});

  const actionIds = models.map((a) => a.id);

  const documentRowsByActionId = (
    await RetrievalDocument.findAll({
      where: {
        retrievalActionId: actionIds,
      },
    })
  ).reduce<{
    [id: ModelId]: RetrievalDocument[];
  }>((acc, d) => {
    if (!acc[d.retrievalActionId]) {
      acc[d.retrievalActionId] = [];
    }
    acc[d.retrievalActionId].push(d);
    return acc;
  }, {});

  const chunkRowsByDocumentId = (
    await RetrievalDocumentChunk.findAll({
      where: {
        retrievalDocumentId: Object.values(documentRowsByActionId).flatMap(
          (docs) => docs.map((d) => d.id)
        ),
      },
    })
  ).reduce<{
    [id: ModelId]: RetrievalDocumentChunk[];
  }>((acc, c) => {
    if (!acc[c.retrievalDocumentId]) {
      acc[c.retrievalDocumentId] = [];
    }
    acc[c.retrievalDocumentId].push(c);
    return acc;
  }, {});

  const actions: RetrievalActionType[] = [];

  for (const id of actionIds) {
    const action = actionById[id];
    const documentRows = documentRowsByActionId[id] ?? [];
    const chunkRows = documentRows.flatMap(
      (d) => chunkRowsByDocumentId[d.id] ?? []
    );

    let relativeTimeFrame: TimeFrame | null = null;
    if (action.relativeTimeFrameDuration && action.relativeTimeFrameUnit) {
      relativeTimeFrame = {
        duration: action.relativeTimeFrameDuration,
        unit: action.relativeTimeFrameUnit,
      };
    }

    const documents: RetrievalDocumentType[] = documentRows.map((d) => {
      const chunks = chunkRows
        .filter((c) => c.retrievalDocumentId === d.id)
        .map((c) => ({
          text: c.text,
          offset: c.offset,
          score: c.score,
        }));
      chunks.sort((a, b) => {
        if (a.score === null && b.score === null) {
          return a.offset - b.offset;
        }
        if (a.score !== null && b.score !== null) {
          return b.score - a.score;
        }
        throw new Error(
          "Unexpected comparison of null and non-null scored chunks."
        );
      });

      return {
        id: d.id,
        dataSourceWorkspaceId: d.dataSourceWorkspaceId,
        dataSourceId: d.dataSourceId,
        sourceUrl: d.sourceUrl,
        documentId: d.documentId,
        reference: d.reference,
        timestamp: d.documentTimestamp.getTime(),
        tags: d.tags,
        score: d.score,
        chunks,
      };
    });

    documents.sort((a, b) => {
      if (a.score === null && b.score === null) {
        return b.timestamp - a.timestamp;
      }
      if (a.score !== null && b.score !== null) {
        return b.score - a.score;
      }
      throw new Error(
        "Unexpected comparison of null and non-null scored documents."
      );
    });

    actions.push(
      new RetrievalAction({
        id: action.id,
        agentMessageId: action.agentMessageId,
        params: {
          query: action.query,
          relativeTimeFrame,
          topK: action.topK,
        },
        functionCallId: action.functionCallId,
        functionCallName: action.functionCallName,
        documents,
        step: action.step,
      })
    );
  }

  return actions;
}

/**
 * Retrieval meta-prompt
 */

export function retrievalMetaPrompt() {
  return (
    "Focus on retrieved data and be factual." +
    " To cite retrieved documents from data sources use the markdown directive :cite[REFERENCE]" +
    " (eg :cite[XX] or :cite[XX,XX] but not :cite[XX][XX])." +
    " Use citations as close as possible to the information you are citing."
  );
}

export function retrievalMetaPromptMutiActions() {
  return (
    "Focus on being factual and accurate. When data is retrieved from sources, " +
    "use the markdown directive :cite[REFERENCE] to cite documents (eg :cite[XX] or :cite[XX,XX] but not :cite[XX][XX]). " +
    "Ensure citations are placed as close as possible to the related information. " +
    "If data retrieval isn't applicable, maintain clarity and precision in your statements."
  );
}

/**
 * Action execution.
 */

let REFS: string[] | null = null;
const getRand = rand("chawarma");

const getRefs = () => {
  if (REFS === null) {
    REFS = "abcdefghijklmnopqrstuvwxyz"
      .split("")
      .map((c) => {
        return "123456789".split("").map((n) => {
          return `${c}${n}`;
        });
      })
      .flat();
    // randomize
    REFS.sort(() => {
      const r = getRand();
      return r > 0.5 ? 1 : -1;
    });
  }
  return REFS;
};

// This method is in charge of running the retrieval and creating an AgentRetrievalAction object in
// the database (along with the RetrievalDocument and RetrievalDocumentChunk objects). It does not
// create any generic model related to the conversation. It is possible for an AgentRetrievalAction
// to be stored (once the query params are infered) but for the retrieval to fail, in which case an
// error event will be emitted and the AgentRetrievalAction won't have any documents associated. The
// error is expected to be stored by the caller on the parent agent message.
export async function* runRetrieval(
  auth: Authenticator,
  {
    configuration,
    actionConfiguration,
    conversation,
    agentMessage,
    rawInputs,
    functionCallId,
    step,
    refsOffset = 0,
  }: {
    configuration: AgentConfigurationType;
    actionConfiguration: RetrievalConfigurationType;
    conversation: ConversationType;
    agentMessage: AgentMessageType;
    rawInputs: Record<string, string | boolean | number>;
    functionCallId: string | null;
    step: number;
    refsOffset?: number;
  }
): AsyncGenerator<
  RetrievalParamsEvent | RetrievalSuccessEvent | RetrievalErrorEvent,
  void
> {
  const owner = auth.workspace();
  if (!owner) {
    throw new Error("Unexpected unauthenticated call to `runRetrieval`");
  }

  let query: string | null = null;
  let relativeTimeFrame: TimeFrame | null = null;

  if (
    actionConfiguration.relativeTimeFrame !== "none" &&
    actionConfiguration.relativeTimeFrame !== "auto"
  ) {
    relativeTimeFrame = actionConfiguration.relativeTimeFrame;
  }

  if (actionConfiguration.query === "auto") {
    if (!rawInputs.query || typeof rawInputs.query !== "string") {
      yield {
        type: "retrieval_error",
        created: Date.now(),
        configurationId: configuration.sId,
        messageId: agentMessage.sId,
        error: {
          code: "retrieval_parameters_generation_error",
          message: `Error generating parameters for retrieval: failed to generate a valid query.`,
        },
      };
      return;
    }
    query = rawInputs.query as string;
  }

  if (actionConfiguration.relativeTimeFrame === "auto") {
    if (
      rawInputs.relativeTimeFrame &&
      typeof rawInputs.relativeTimeFrame === "string"
    ) {
      relativeTimeFrame = parseTimeFrame(rawInputs.relativeTimeFrame);
    }
  }

  const { model } = configuration;

  let topK = 16;
  if (actionConfiguration.topK === "auto") {
    const supportedModel = getSupportedModelConfig(model);
    if (actionConfiguration.query === "none") {
      topK = supportedModel.recommendedExhaustiveTopK;
    } else {
      topK = supportedModel.recommendedTopK;
    }
  } else {
    topK = actionConfiguration.topK;
  }

  // Create the AgentRetrievalAction object in the database and yield an event for the generation of
  // the params. We store the action here as the params have been generated, if an error occurs
  // later on, the action won't have retrieved documents but the error will be stored on the parent
  // agent message.
  const action = await AgentRetrievalAction.create({
    query: query,
    relativeTimeFrameDuration: relativeTimeFrame?.duration ?? null,
    relativeTimeFrameUnit: relativeTimeFrame?.unit ?? null,
    topK,
    retrievalConfigurationId: actionConfiguration.sId,
    functionCallId,
    functionCallName: actionConfiguration.name,
    agentMessageId: agentMessage.agentMessageId,
    step: step,
  });

  yield {
    type: "retrieval_params",
    created: Date.now(),
    configurationId: configuration.sId,
    messageId: agentMessage.sId,
    dataSources: actionConfiguration.dataSources,
    action: new RetrievalAction({
      id: action.id,
      agentMessageId: agentMessage.agentMessageId,
      params: {
        relativeTimeFrame,
        query,
        topK,
      },
      functionCallId: action.functionCallId,
      functionCallName: action.functionCallName,
      documents: null,
      step: action.step,
    }),
  };

  const now = Date.now();

  const config = cloneBaseConfig(
    DustProdActionRegistry["assistant-v2-retrieval"].config
  );

  // Handle data sources list and parents/tags filtering.
  config.DATASOURCE.data_sources = actionConfiguration.dataSources.map((d) => ({
    workspace_id: isDevelopment()
      ? PRODUCTION_DUST_WORKSPACE_ID
      : d.workspaceId,
    data_source_id: d.dataSourceId,
  }));

  for (const ds of actionConfiguration.dataSources) {
    // Not: empty array in parents/tags.in means "no document match" since no documents has any
    // tags/parents that is in the empty array.
    if (!config.DATASOURCE.filter.parents) {
      config.DATASOURCE.filter.parents = {};
    }
    if (ds.filter.parents?.in) {
      if (!config.DATASOURCE.filter.parents.in_map) {
        config.DATASOURCE.filter.parents.in_map = {};
      }
      config.DATASOURCE.filter.parents.in_map[ds.dataSourceId] =
        ds.filter.parents.in;
    }
    if (ds.filter.parents?.not) {
      if (!config.DATASOURCE.filter.parents.not) {
        config.DATASOURCE.filter.parents.not = [];
      }
      config.DATASOURCE.filter.parents.not.push(...ds.filter.parents.not);
    }
  }

  // Handle timestamp filtering.
  if (relativeTimeFrame) {
    config.DATASOURCE.filter.timestamp = {
      gt: timeFrameFromNow(relativeTimeFrame),
    };
  }

  // Handle top k.
  config.DATASOURCE.top_k = topK;

  const res = await runActionStreamed(
    auth,
    "assistant-v2-retrieval",
    config,
    [
      {
        query,
      },
    ],
    {
      conversationId: conversation.sId,
      workspaceId: conversation.owner.sId,
      agentMessageId: agentMessage.sId,
    }
  );

  if (res.isErr()) {
    logger.error(
      {
        workspaceId: owner.id,
        conversationId: conversation.id,
        error: res.error,
      },
      "Error running retrieval"
    );
    yield {
      type: "retrieval_error",
      created: Date.now(),
      configurationId: configuration.sId,
      messageId: agentMessage.sId,
      error: {
        code: "retrieval_search_error",
        message: `Error searching data sources: ${res.error.message}`,
      },
    };
    return;
  }

  const { eventStream } = res.value;

  let documents: RetrievalDocumentType[] = [];

  // This is not perfect and will be erroneous in case of two data sources with the same id from two
  // different workspaces. We don't support cross workspace data sources right now. But we'll likely
  // want `core` to return the `workspace_id` that was used eventualy.
  // TODO(spolu): make `core` return data source workspace id.
  const dataSourcesIdToWorkspaceId: { [key: string]: string } = {};
  for (const ds of actionConfiguration.dataSources) {
    dataSourcesIdToWorkspaceId[ds.dataSourceId] = ds.workspaceId;
  }

  for await (const event of eventStream) {
    if (event.type === "error") {
      logger.error(
        {
          workspaceId: owner.id,
          conversationId: conversation.id,
          error: event.content.message,
        },
        "Error running retrieval"
      );
      yield {
        type: "retrieval_error",
        created: Date.now(),
        configurationId: configuration.sId,
        messageId: agentMessage.sId,
        error: {
          code: "retrieval_search_error",
          message: `Error searching data sources: ${event.content.message}`,
        },
      };
      return;
    }

    if (event.type === "block_execution") {
      const e = event.content.execution[0][0];
      if (e.error) {
        logger.error(
          {
            workspaceId: owner.id,
            conversationId: conversation.id,
            error: e.error,
          },
          "Error running retrieval"
        );
        yield {
          type: "retrieval_error",
          created: Date.now(),
          configurationId: configuration.sId,
          messageId: agentMessage.sId,
          error: {
            code: "retrieval_search_error",
            message: `Error searching data sources: ${e.error}`,
          },
        };
        return;
      }

      if (event.content.block_name === "DATASOURCE" && e.value) {
        const v = e.value as {
          data_source_id: string;
          created: number;
          document_id: string;
          timestamp: number;
          tags: string[];
          parents: string[];
          source_url: string | null;
          hash: string;
          text_size: number;
          chunk_count: number;
          chunks: {
            text: string;
            hash: string;
            offset: number;
            score: number;
          }[];
          token_count: number;
        }[];

        const refs = getRefs().slice(refsOffset, refsOffset + v.length);

        documents = v.map((d, i) => {
          const reference = refs[i % refs.length];
          return {
            id: 0, // dummy pending database insertion
            dataSourceWorkspaceId: dataSourcesIdToWorkspaceId[d.data_source_id],
            dataSourceId: d.data_source_id,
            documentId: d.document_id,
            reference,
            timestamp: d.timestamp,
            tags: d.tags,
            sourceUrl: d.source_url ?? null,
            score: d.chunks.map((c) => c.score)[0],
            chunks: d.chunks.map((c) => ({
              text: c.text,
              offset: c.offset,
              score: c.score,
            })),
          };
        });
      }
    }
  }

  // We are done, store documents and chunks in database and yield the final events.

  await frontSequelize.transaction(async (t) => {
    for (const d of documents) {
      const document = await RetrievalDocument.create(
        {
          dataSourceWorkspaceId: d.dataSourceWorkspaceId,
          dataSourceId: d.dataSourceId,
          sourceUrl: d.sourceUrl,
          documentId: d.documentId,
          reference: d.reference,
          documentTimestamp: new Date(d.timestamp),
          tags: d.tags,
          score: d.score,
          retrievalActionId: action.id,
        },
        { transaction: t }
      );

      d.id = document.id;

      for (const c of d.chunks) {
        await RetrievalDocumentChunk.create(
          {
            text: c.text,
            offset: c.offset,
            score: c.score,
            retrievalDocumentId: document.id,
          },
          { transaction: t }
        );
      }
    }
  });

  logger.info(
    {
      workspaceId: conversation.owner.sId,
      conversationId: conversation.sId,
      elapsed: Date.now() - now,
    },
    "[ASSISTANT_TRACE] Retrieval action execution"
  );

  yield {
    type: "retrieval_success",
    created: Date.now(),
    configurationId: configuration.sId,
    messageId: agentMessage.sId,
    action: new RetrievalAction({
      id: action.id,
      agentMessageId: agentMessage.agentMessageId,
      params: {
        relativeTimeFrame: relativeTimeFrame,
        query: query,
        topK,
      },
      functionCallId: action.functionCallId,
      functionCallName: action.functionCallName,
      documents,
      step: action.step,
    }),
  };
}
