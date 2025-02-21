import type {
  ContentFragmentType,
  ConversationType,
  ConversationVisibility,
  InternalPostConversationsRequestBodySchema,
  MentionType,
  Result,
  UserMessageWithRankType,
  UserType,
  WorkspaceType,
} from "@dust-tt/types";
import { Err, Ok } from "@dust-tt/types";
import type * as t from "io-ts";

import type { NotificationType } from "@app/components/sparkle/Notification";
import type { PostConversationsResponseBody } from "@app/pages/api/w/[wId]/assistant/conversations";

/**
 * id of the parent div that should be scrolled for autosrcolling to work on
 * conversations
 */
export const CONVERSATION_PARENT_SCROLL_DIV_ID = {
  modal: "modal-content",
  page: "main-content",
};

export type ConversationErrorType = {
  type:
    | "attachment_upload_error"
    | "message_send_error"
    | "plan_limit_reached_error";
  title: string;
  message: string;
};

export type ContentFragmentInput = {
  title: string;
  content: string;
  file: File;
};

export function createPlaceholderUserMessage({
  input,
  mentions,
  user,
  lastMessageRank,
}: {
  input: string;
  mentions: MentionType[];
  user: UserType;
  lastMessageRank: number;
}): UserMessageWithRankType {
  const createdAt = new Date().getTime();
  const { email, fullName, image, username } = user;

  return {
    id: -1,
    content: input,
    created: createdAt,
    mentions,
    user,
    visibility: "visible",
    type: "user_message",
    sId: `placeholder-${createdAt.toString()}`,
    version: 0,
    rank: lastMessageRank + 1,
    context: {
      email,
      fullName,
      profilePictureUrl: image,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
      username,
    },
  };
}

export async function submitMessage({
  owner,
  user,
  conversationId,
  messageData,
}: {
  owner: WorkspaceType;
  user: UserType;
  conversationId: string;
  messageData: {
    input: string;
    mentions: MentionType[];
    contentFragments: ContentFragmentInput[];
  };
}): Promise<
  Result<{ message: UserMessageWithRankType }, ConversationErrorType>
> {
  const { input, mentions, contentFragments } = messageData;
  // Create a new content fragment.
  if (contentFragments.length > 0) {
    const contentFragmentsRes = await Promise.all(
      contentFragments.map((contentFragment) => {
        return fetch(
          `/api/w/${owner.sId}/assistant/conversations/${conversationId}/content_fragment`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              title: contentFragment.title,
              content: contentFragment.content,
              url: null,
              contentType: "file_attachment",
              context: {
                timezone:
                  Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
                profilePictureUrl: user.image,
              },
            }),
          }
        );
      })
    );

    for (const [i, mcfRes] of contentFragmentsRes.entries()) {
      if (!mcfRes.ok) {
        const data = await mcfRes.json();
        console.error("Error creating content fragment", data);
        return new Err({
          type: "attachment_upload_error",
          title: "Error uploading file.",
          message: data.error.message || "Please try again or contact us.",
        });
      }
      const cfData = (await mcfRes.json())
        .contentFragment as ContentFragmentType;
      uploadRawContentFragment({
        workspaceId: owner.sId,
        conversationId,
        contentFragmentId: cfData.sId,
        file: contentFragments[i].file,
      });
    }
  }

  // Create a new user message.
  const mRes = await fetch(
    `/api/w/${owner.sId}/assistant/conversations/${conversationId}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content: input,
        context: {
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
          profilePictureUrl: user.image,
        },
        mentions,
      }),
    }
  );

  if (!mRes.ok) {
    const data = await mRes.json();
    return new Err({
      type:
        data.error.type === "plan_message_limit_exceeded"
          ? "plan_limit_reached_error"
          : "message_send_error",
      title: "Your message could not be sent.",
      message: data.error.message || "Please try again or contact us.",
    });
  }

  return new Ok(await mRes.json());
}

export async function deleteConversation({
  workspaceId,
  conversationId,
  sendNotification,
}: {
  workspaceId: string;
  conversationId: string;
  sendNotification: (notification: NotificationType) => void;
}) {
  const res = await fetch(
    `/api/w/${workspaceId}/assistant/conversations/${conversationId}`,
    {
      method: "DELETE",
    }
  );

  if (!res.ok) {
    const data = await res.json();
    sendNotification({
      title: "Error deleting conversation.",
      description: data.error.message || "Please try again or contact us.",
      type: "error",
    });
    return;
  }
}

export async function createConversationWithMessage({
  owner,
  user,
  messageData,
  visibility = "unlisted",
  title,
}: {
  owner: WorkspaceType;
  user: UserType;
  messageData: {
    input: string;
    mentions: MentionType[];
    contentFragments: ContentFragmentInput[];
  };
  visibility?: ConversationVisibility;
  title?: string;
}): Promise<Result<ConversationType, ConversationErrorType>> {
  const { input, mentions, contentFragments } = messageData;

  const body: t.TypeOf<typeof InternalPostConversationsRequestBodySchema> = {
    title: title ?? null,
    visibility,
    message: {
      content: input,
      context: {
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        profilePictureUrl: user.image,
      },
      mentions,
    },
    contentFragments: contentFragments.map((cf) => ({
      content: cf.content,
      title: cf.title,
      url: null, // sourceUrl will be set on raw content upload success
      contentType: "file_attachment",
      context: {
        profilePictureUrl: user.image,
      },
    })),
  };

  // Create new conversation and post the initial message at the same time.
  const cRes = await fetch(`/api/w/${owner.sId}/assistant/conversations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!cRes.ok) {
    const data = await cRes.json();
    return new Err({
      type:
        data.error.type === "plan_message_limit_exceeded"
          ? "plan_limit_reached_error"
          : "message_send_error",
      title: "Your message could not be sent.",
      message: data.error.message || "Please try again or contact us.",
    });
  }

  const conversationData = (await cRes.json()) as PostConversationsResponseBody;

  if (conversationData.contentFragments.length > 0) {
    for (const [i, cf] of conversationData.contentFragments.entries()) {
      uploadRawContentFragment({
        workspaceId: owner.sId,
        conversationId: conversationData.conversation.sId,
        contentFragmentId: cf.sId,
        file: contentFragments[i].file,
      });
    }
  }

  return new Ok(conversationData.conversation);
}

function uploadRawContentFragment({
  workspaceId,
  conversationId,
  contentFragmentId,
  file,
}: {
  workspaceId: string;
  conversationId: string;
  contentFragmentId: string;
  file: File;
}) {
  const formData = new FormData();
  formData.append("file", file);

  // do not await, to avoid slowing the UX
  // an error from this function does not prevent the conversation from continuing
  // API errors are handled server side
  fetch(
    `/api/w/${workspaceId}/assistant/conversations/${conversationId}/messages/${contentFragmentId}/raw_content_fragment`,
    {
      method: "POST",
      body: formData,
    }
  ).catch((e) => {
    console.error(`Error uploading raw content for file`, e);
  });
}
