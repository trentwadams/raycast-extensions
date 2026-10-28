import {
  Action,
  ActionPanel,
  Alert,
  closeMainWindow,
  confirmAlert,
  Form,
  Icon,
  Keyboard,
  showHUD,
  showToast,
  Toast,
  useNavigation,
} from "@raycast/api";
import { randomUUID } from "node:crypto";
import {
  dispatchCommand,
  errorMessage,
  focusThread,
  ServerInfo,
  Thread,
  threadLink,
} from "./t3";
import {
  isRunning,
  pendingApproval,
  Section,
  SnoozePresetSetting,
  snoozeChoices,
  StatusLabel,
} from "./thread-state";

type ThreadCommand = { type: string } & Record<string, unknown>;

const shortcut = (
  modifiers: ("shift" | "opt")[],
  key: Keyboard.KeyEquivalent,
): Keyboard.Shortcut => ({
  macOS: { modifiers: ["cmd", ...modifiers], key },
  Windows: {
    modifiers: ["ctrl", ...modifiers.map((m) => (m === "opt" ? "alt" : m))],
    key,
  },
});

const SHORTCUTS = {
  approve: shortcut(["shift"], "y"),
  decline: shortcut(["shift"], "n"),
  stop: shortcut(["shift"], "."),
  settle: shortcut(["shift"], "e"),
  snooze: shortcut(["shift"], "s"),
  read: shortcut(["shift"], "u"),
};

/** Sends one command for the thread and reports the outcome; `onDone` reloads the list. */
async function run(
  thread: Thread,
  command: ThreadCommand,
  messages: { progress: string; done: string; failed: string },
  onDone: () => void,
  undo?: { title: string; command: ThreadCommand },
) {
  const toast = await showToast({
    style: Toast.Style.Animated,
    title: messages.progress,
  });
  try {
    await dispatchCommand({ threadId: thread.id, ...command });
    toast.style = Toast.Style.Success;
    toast.title = messages.done;
    if (undo) {
      toast.primaryAction = {
        title: undo.title,
        onAction: () =>
          run(
            thread,
            undo.command,
            {
              progress: "Undoing",
              done: "Undone",
              failed: "Could not undo",
            },
            onDone,
          ),
      };
    }
    onDone();
  } catch (error) {
    toast.style = Toast.Style.Failure;
    toast.title = messages.failed;
    toast.message = errorMessage(error);
  }
}

/** Opens the thread in T3 Code. The Raycast window closes first, so failures go to a HUD. */
export async function openThread(thread: Thread, projectTitle?: string) {
  await closeMainWindow();
  try {
    const outcome = await focusThread({
      id: thread.id,
      title: thread.title,
      projectTitle,
      branch: thread.branch,
    });
    if (outcome === "ambiguous") {
      await showHUD("Several threads match - pick one in the T3 Code palette");
    } else if (outcome === "unfocused") {
      await showHUD("Open the thread from T3 Code's palette");
    }
  } catch (error) {
    await showHUD(`Could not open T3 Code: ${errorMessage(error)}`);
  }
}

export function ThreadActions(props: {
  thread: Thread;
  projectTitle: string | undefined;
  section: Section;
  status: StatusLabel | null;
  server: ServerInfo | undefined;
  snoozePresets: SnoozePresetSetting[];
  onChange: () => void;
}) {
  const { thread, projectTitle, section, status, server, onChange } = props;
  const v2 = (server?.protocolVersion ?? 1) >= 2;
  const can = (capability: string) =>
    v2 && server?.capabilities[capability] === true;
  const approval = v2 ? pendingApproval(thread) : null;
  const running = isRunning(thread);
  const send = (
    command: ThreadCommand,
    messages: { progress: string; done: string; failed: string },
    undo?: { title: string; command: ThreadCommand },
  ) => run(thread, command, messages, onChange, undo);

  async function approve() {
    if (!approval) {
      return;
    }
    const confirmed = await confirmAlert({
      title: "Approve this request?",
      message: `The agent in “${thread.title}” is waiting on a ${approval.kind.replace(/_/g, " ")} approval. Raycast can't show what it wants to do, so open the thread to review it first if you're not sure.`,
      primaryAction: { title: "Approve" },
    });
    if (confirmed) {
      await send(
        {
          type: "runtime-request.respond",
          requestId: approval.id,
          decision: "accept",
        },
        {
          progress: "Approving",
          done: "Approved",
          failed: "Could not approve",
        },
      );
    }
  }

  async function remove() {
    const confirmed = await confirmAlert({
      title: "Delete this thread?",
      message: `“${thread.title}” and its history are removed from T3 Code.`,
      primaryAction: { title: "Delete", style: Alert.ActionStyle.Destructive },
    });
    if (confirmed) {
      await send(
        { type: "thread.delete" },
        {
          progress: "Deleting thread",
          done: "Thread deleted",
          failed: "Could not delete the thread",
        },
      );
    }
  }

  const unread = status === "Completed" || status === "Failed";

  return (
    <ActionPanel>
      <ActionPanel.Section>
        <Action
          title="Open in T3 Code"
          icon={Icon.ArrowRight}
          onAction={() => openThread(thread, projectTitle)}
        />
        {v2 ? (
          <Action.Push
            title="Reply"
            icon={Icon.Reply}
            target={<ReplyForm thread={thread} onSent={onChange} />}
          />
        ) : null}
        {approval ? (
          <>
            <Action
              title="Approve Request"
              icon={Icon.Checkmark}
              shortcut={SHORTCUTS.approve}
              onAction={approve}
            />
            <Action
              title="Decline Request"
              icon={Icon.XMarkCircle}
              shortcut={SHORTCUTS.decline}
              onAction={() =>
                send(
                  {
                    type: "runtime-request.respond",
                    requestId: approval.id,
                    decision: "decline",
                  },
                  {
                    progress: "Declining",
                    done: "Declined",
                    failed: "Could not decline",
                  },
                )
              }
            />
          </>
        ) : null}
        {running && can("threadStop") ? (
          <Action
            title="Stop Agent"
            icon={Icon.Stop}
            shortcut={SHORTCUTS.stop}
            onAction={() =>
              send(
                { type: "thread.stop" },
                {
                  progress: "Stopping",
                  done: "Stopped",
                  failed: "Could not stop the agent",
                },
              )
            }
          />
        ) : null}
      </ActionPanel.Section>
      {v2 ? (
        <ActionPanel.Section title="Organize">
          {can("threadSettlement") ? (
            section === "settled" ? (
              <Action
                title="Unsettle"
                icon={Icon.ArrowCounterClockwise}
                shortcut={SHORTCUTS.settle}
                onAction={() =>
                  send(
                    { type: "thread.unsettle", reason: "user" },
                    {
                      progress: "Unsettling",
                      done: "Moved back to Active",
                      failed: "Could not unsettle",
                    },
                  )
                }
              />
            ) : (
              <Action
                title="Settle"
                icon={Icon.CheckCircle}
                shortcut={SHORTCUTS.settle}
                onAction={() =>
                  send(
                    { type: "thread.settle" },
                    {
                      progress: "Settling",
                      done: "Settled",
                      failed: "Could not settle",
                    },
                    {
                      title: "Undo",
                      command: { type: "thread.unsettle", reason: "user" },
                    },
                  )
                }
              />
            )
          ) : null}
          {can("threadSnooze") ? (
            section === "snoozed" ? (
              <Action
                title="Unsnooze"
                icon={Icon.Alarm}
                shortcut={SHORTCUTS.snooze}
                onAction={() =>
                  send(
                    { type: "thread.unsnooze", reason: "user" },
                    {
                      progress: "Waking thread",
                      done: "Unsnoozed",
                      failed: "Could not unsnooze",
                    },
                  )
                }
              />
            ) : !thread.pendingRuntimeRequest &&
              (thread.pendingGuestMessageCount ?? 0) === 0 ? (
              // The server refuses to snooze a thread with a request waiting on you.
              <SnoozeMenu
                presets={props.snoozePresets}
                onSnooze={(until, label) =>
                  send(
                    {
                      type: "thread.snooze",
                      snoozedUntil: until.toISOString(),
                    },
                    {
                      progress: "Snoozing",
                      done: `Snoozed until ${label}`,
                      failed: "Could not snooze",
                    },
                    {
                      title: "Undo",
                      command: { type: "thread.unsnooze", reason: "user" },
                    },
                  )
                }
              />
            ) : null
          ) : null}
          {can("threadPinning") ? (
            <Action
              title={thread.pinnedAt ? "Unpin" : "Pin"}
              icon={thread.pinnedAt ? Icon.TackDisabled : Icon.Tack}
              shortcut={Keyboard.Shortcut.Common.Pin}
              onAction={() =>
                send(
                  { type: thread.pinnedAt ? "thread.unpin" : "thread.pin" },
                  thread.pinnedAt
                    ? {
                        progress: "Unpinning",
                        done: "Unpinned",
                        failed: "Could not unpin",
                      }
                    : {
                        progress: "Pinning",
                        done: "Pinned",
                        failed: "Could not pin",
                      },
                )
              }
            />
          ) : null}
          {can("threadVisitedTracking") ? (
            <Action
              title={unread ? "Mark as Read" : "Mark as Unread"}
              icon={unread ? Icon.Eye : Icon.EyeDisabled}
              shortcut={SHORTCUTS.read}
              onAction={() =>
                send(
                  unread
                    ? {
                        type: "thread.visit",
                        visitedAt: new Date().toISOString(),
                      }
                    : { type: "thread.mark-unread" },
                  {
                    progress: "Updating",
                    done: unread ? "Marked as read" : "Marked as unread",
                    failed: "Could not update the thread",
                  },
                )
              }
            />
          ) : null}
          <Action.Push
            title="Rename"
            icon={Icon.Pencil}
            shortcut={Keyboard.Shortcut.Common.Edit}
            target={<RenameForm thread={thread} onRenamed={onChange} />}
          />
          <Action
            title="Archive"
            icon={Icon.Box}
            onAction={() =>
              send(
                { type: "thread.archive" },
                {
                  progress: "Archiving",
                  done: "Archived",
                  failed: "Could not archive",
                },
                { title: "Undo", command: { type: "thread.unarchive" } },
              )
            }
          />
          <Action
            title="Delete"
            icon={Icon.Trash}
            style={Action.Style.Destructive}
            shortcut={Keyboard.Shortcut.Common.Remove}
            onAction={remove}
          />
        </ActionPanel.Section>
      ) : null}
      <ActionPanel.Section>
        {server?.environmentId ? (
          <Action.CopyToClipboard
            title="Copy Thread Link"
            content={threadLink(server.environmentId, thread.id)}
            shortcut={Keyboard.Shortcut.Common.CopyDeeplink}
          />
        ) : null}
        <Action.CopyToClipboard title="Copy Thread ID" content={thread.id} />
        <Action
          title="Refresh"
          icon={Icon.ArrowClockwise}
          shortcut={Keyboard.Shortcut.Common.Refresh}
          onAction={onChange}
        />
      </ActionPanel.Section>
    </ActionPanel>
  );
}

function SnoozeMenu(props: {
  presets: SnoozePresetSetting[];
  onSnooze: (until: Date, label: string) => void;
}) {
  // Resolved when the panel renders, so "In 1 hour" counts from roughly now; the
  // durations are re-resolved on pick below.
  const choices = snoozeChoices(props.presets);
  return (
    <ActionPanel.Submenu
      title="Snooze"
      icon={Icon.Clock}
      shortcut={SHORTCUTS.snooze}
    >
      {choices.map((choice) => {
        const when = choice.until.toLocaleString(undefined, {
          weekday: "short",
          hour: "numeric",
          minute: "2-digit",
        });
        return (
          <Action
            key={choice.id}
            title={`${choice.label} (${when})`}
            onAction={() => {
              const minutes = /^after:(\d+)$/.exec(choice.id)?.[1];
              const until = minutes
                ? new Date(Date.now() + Number(minutes) * 60_000)
                : choice.until;
              props.onSnooze(until, when);
            }}
          />
        );
      })}
    </ActionPanel.Submenu>
  );
}

function ReplyForm(props: { thread: Thread; onSent: () => void }) {
  const { pop } = useNavigation();
  const running = isRunning(props.thread);
  return (
    <Form
      navigationTitle={`Reply to ${props.thread.title}`}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title={running ? "Queue Message" : "Send Message"}
            icon={Icon.Upload}
            onSubmit={async (values: { text: string }) => {
              const text = values.text.trim();
              if (!text) {
                await showToast({
                  style: Toast.Style.Failure,
                  title: "Write a message first",
                });
                return;
              }
              const messageId = randomUUID();
              await run(
                props.thread,
                {
                  type: "message.dispatch",
                  messageId,
                  text,
                  attachments: [],
                  // A busy agent takes the message after its current run, the way
                  // T3's composer queues it.
                  dispatchMode: {
                    type: running ? "queue_after_active" : "start_immediately",
                  },
                  createdBy: "user",
                  creationSource: "web",
                },
                {
                  progress: running ? "Queueing message" : "Sending message",
                  done: running ? "Message queued" : "Message sent",
                  failed: "Could not send the message",
                },
                () => {
                  props.onSent();
                  pop();
                },
              );
            }}
          />
        </ActionPanel>
      }
    >
      <Form.Description
        text={
          running
            ? "The agent is working, so this message is queued to run after it finishes."
            : "Sends a follow-up to this thread's agent."
        }
      />
      <Form.TextArea id="text" title="Message" enableMarkdown autoFocus />
    </Form>
  );
}

function RenameForm(props: { thread: Thread; onRenamed: () => void }) {
  const { pop } = useNavigation();
  return (
    <Form
      navigationTitle="Rename Thread"
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Rename"
            icon={Icon.Pencil}
            onSubmit={async (values: { title: string }) => {
              const title = values.title.trim();
              if (!title || title === props.thread.title) {
                pop();
                return;
              }
              await run(
                props.thread,
                { type: "thread.metadata.update", title },
                {
                  progress: "Renaming",
                  done: "Renamed",
                  failed: "Could not rename the thread",
                },
                () => {
                  props.onRenamed();
                  pop();
                },
              );
            }}
          />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="title"
        title="Title"
        defaultValue={props.thread.title}
        autoFocus
      />
    </Form>
  );
}
