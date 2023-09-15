import { Avatar } from "@dust-tt/sparkle";

/**
 * Parent component for both UserMessage and AgentMessage, to ensure avatar,
 * side buttons and spacing are consistent between the two
 */
export function ConversationMessage({
  children,
  name,
  pictureUrl,
  buttons,
}: {
  children?: React.ReactNode;
  name: string | null;
  pictureUrl?: string | null;
  buttons?: React.ReactNode[];
}) {
  return (
    <div className="flex w-full flex-row gap-4">
      <div className="flex-shrink-0">
        <Avatar visual={pictureUrl} name={name || undefined} size="sm" />
      </div>
      <div className="min-w-0 flex-grow">
        <div className="flex flex-col gap-4">
          <div className="text-sm font-medium">{name}</div>
          <div className="min-w-0 break-words text-base font-normal">
            {children}
          </div>
        </div>
      </div>
      <div className="flex flex-col items-start gap-2 sm:flex-row">
        {buttons}
      </div>
    </div>
  );
}
