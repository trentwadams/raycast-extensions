import {
  Action,
  ActionPanel,
  Alert,
  Color,
  confirmAlert,
  Form,
  Icon,
  Keyboard,
  List,
  openExtensionPreferences,
  showToast,
  Toast,
  useNavigation,
} from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { randomUUID } from "node:crypto";
import { useCallback, useEffect, useState } from "react";
import {
  checkConnection,
  ConnectionCheck,
  Environment,
  environmentIdAt,
  environmentLabel,
  errorMessage,
  exchangePairingCredential,
  failureSummary,
  loadEnvironments,
  loadStoredEnvironments,
  originProblem,
  parsePairingLink,
  storeEnvironments,
  trimOrigin,
} from "./t3";

const TOKEN_COMMAND =
  "t3 auth session issue --ttl 365d --label raycast --scope orchestration:read --scope orchestration:operate --token-only";

const hostOf = (origin: string) => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

/** The name given to it, else the server's own, else its address. */
const displayName = (environment: Environment, check?: ConnectionCheck) =>
  environment.name || check?.label || hostOf(environment.origin);

/** Reads the stored list fresh before changing it, so an edit never writes back a
 * copy that another command changed in the meantime. */
async function changeStored(change: (stored: Environment[]) => Environment[]) {
  await storeEnvironments(change(await loadStoredEnvironments()));
}

export default function Command() {
  const { data, isLoading, revalidate } = usePromise(loadEnvironments);
  const [primary, ...stored] = data ?? [];

  async function move(environment: Environment, by: -1 | 1) {
    await changeStored((list) => {
      const from = list.findIndex((entry) => entry.key === environment.key);
      const to = from + by;
      if (from < 0 || to < 0 || to >= list.length) {
        return list;
      }
      const next = [...list];
      [next[from], next[to]] = [next[to], next[from]];
      return next;
    });
    revalidate();
  }

  async function remove(environment: Environment, name: string) {
    const confirmed = await confirmAlert({
      title: `Remove ${name}?`,
      message:
        "Its threads and projects leave every list. The token stays valid on that computer until you revoke it there with t3 auth session revoke.",
      icon: { source: Icon.Trash, tintColor: Color.Red },
      primaryAction: { title: "Remove", style: Alert.ActionStyle.Destructive },
    });
    if (!confirmed) {
      return;
    }
    await changeStored((list) =>
      list.filter((entry) => entry.key !== environment.key),
    );
    revalidate();
    await showToast({ style: Toast.Style.Success, title: `Removed ${name}` });
  }

  const addAction = (
    <Action.Push
      title="Add Environment"
      icon={Icon.Plus}
      shortcut={Keyboard.Shortcut.Common.New}
      target={<EnvironmentForm onSaved={revalidate} />}
    />
  );

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Search environments">
      <List.EmptyView
        title="No Matching Environments"
        icon={Icon.Network}
        actions={<ActionPanel>{addAction}</ActionPanel>}
      />
      {primary ? (
        <List.Section title="This Computer">
          <EnvironmentItem
            environment={primary}
            icon={Icon.Monitor}
            actions={() => (
              <>
                <Action
                  title="Open Extension Settings"
                  icon={Icon.Gear}
                  onAction={openExtensionPreferences}
                />
                {addAction}
              </>
            )}
          />
        </List.Section>
      ) : null}
      {data ? (
        <List.Section
          title="Other Environments"
          subtitle={stored.length > 0 ? String(stored.length) : undefined}
        >
          {stored.length === 0 ? (
            <List.Item
              title="Add an Environment"
              subtitle="Another computer's T3 Code server, such as a Mac on your tailnet. Its threads and projects join every list."
              icon={Icon.PlusCircle}
              actions={<ActionPanel>{addAction}</ActionPanel>}
            />
          ) : null}
          {stored.map((environment, index) => (
            <EnvironmentItem
              key={environment.key}
              environment={environment}
              icon={Icon.Network}
              actions={(name) => (
                <>
                  <Action.Push
                    title="Edit Environment"
                    icon={Icon.Pencil}
                    shortcut={Keyboard.Shortcut.Common.Edit}
                    target={
                      <EnvironmentForm
                        environment={environment}
                        onSaved={revalidate}
                      />
                    }
                  />
                  {addAction}
                  {index > 0 ? (
                    <Action
                      title="Move Earlier"
                      icon={Icon.ArrowUp}
                      shortcut={Keyboard.Shortcut.Common.MoveUp}
                      onAction={() => move(environment, -1)}
                    />
                  ) : null}
                  {index < stored.length - 1 ? (
                    <Action
                      title="Move Later"
                      icon={Icon.ArrowDown}
                      shortcut={Keyboard.Shortcut.Common.MoveDown}
                      onAction={() => move(environment, 1)}
                    />
                  ) : null}
                  <Action
                    title="Remove Environment"
                    icon={Icon.Trash}
                    style={Action.Style.Destructive}
                    shortcut={Keyboard.Shortcut.Common.Remove}
                    onAction={() => remove(environment, name)}
                  />
                </>
              )}
            />
          ))}
        </List.Section>
      ) : null}
    </List>
  );
}

type Connection =
  | { state: "checking" }
  | { state: "ok"; check: ConnectionCheck }
  | { state: "failed"; error: Error };

/** One environment with its live status. The check runs when the row appears and
 * again on Test Connection, which also reports the result in a toast. */
function EnvironmentItem(props: {
  environment: Environment;
  icon: Icon;
  actions: (name: string) => ActionPanel.Section.Props["children"];
}) {
  const { environment } = props;
  const [connection, setConnection] = useState<Connection>({
    state: "checking",
  });

  const test = useCallback(
    async (announce: boolean) => {
      setConnection({ state: "checking" });
      const toast = announce
        ? await showToast({
            style: Toast.Style.Animated,
            title: `Checking ${displayName(environment)}`,
          })
        : undefined;
      try {
        const check = await checkConnection(environment);
        setConnection({ state: "ok", check });
        if (toast) {
          toast.style = Toast.Style.Success;
          toast.title = `Connected to ${displayName(environment, check)}`;
          toast.message = connectionSummary(check);
        }
      } catch (caught) {
        const error =
          caught instanceof Error ? caught : new Error(String(caught));
        setConnection({ state: "failed", error });
        if (toast) {
          toast.style = Toast.Style.Failure;
          toast.title = `${displayName(environment)} ${failureSummary(error)}`;
          toast.message = error.message;
        }
      }
    },
    [environment],
  );

  useEffect(() => {
    void test(false);
  }, [test]);

  const check = connection.state === "ok" ? connection.check : undefined;
  const name = displayName(environment, check);
  return (
    <List.Item
      title={name}
      subtitle={environment.origin}
      icon={props.icon}
      keywords={[hostOf(environment.origin), check?.label ?? ""]}
      accessories={statusAccessories(environment, connection)}
      actions={
        <ActionPanel>
          <ActionPanel.Section>{props.actions(name)}</ActionPanel.Section>
          <ActionPanel.Section>
            <Action
              title="Test Connection"
              icon={Icon.Wifi}
              shortcut={Keyboard.Shortcut.Common.Refresh}
              onAction={() => test(true)}
            />
            <Action.CopyToClipboard
              title="Copy Origin"
              content={environment.origin}
              shortcut={Keyboard.Shortcut.Common.Copy}
            />
            {connection.state === "failed" ? (
              <Action.CopyToClipboard
                title="Copy Error"
                content={`${name} (${environment.origin}): ${connection.error.message}`}
              />
            ) : null}
          </ActionPanel.Section>
        </ActionPanel>
      }
    />
  );
}

const connectionSummary = (check: ConnectionCheck) =>
  [
    check.serverVersion,
    `${check.threadCount} ${check.threadCount === 1 ? "thread" : "threads"}`,
  ]
    .filter(Boolean)
    .join(" · ");

/** The server's own name when a different one was given, then its version, or the
 * reason it could not be read. */
function statusAccessories(
  environment: Environment,
  connection: Connection,
): List.Item.Accessory[] {
  switch (connection.state) {
    case "checking":
      return [{ icon: Icon.CircleProgress, text: "Checking" }];
    case "failed":
      return [
        {
          tag: {
            value: failureSummary(connection.error),
            color: Color.Red,
          },
          tooltip: connection.error.message,
        },
      ];
    case "ok": {
      const { check } = connection;
      return [
        ...(environment.name && check.label && check.label !== environment.name
          ? [{ text: check.label, tooltip: "The server's own name" }]
          : []),
        {
          tag: {
            value: check.serverVersion ?? "connected",
            color: Color.Green,
          },
          tooltip: connectionSummary(check),
        },
      ];
    }
  }
}

type FormValues = {
  name: string;
  origin: string;
  token: string;
  pairingLink: string;
};

/** Adds an environment, or edits one when given it. Saving checks the origin against
 * the token rule, refuses a second entry for a server already listed, and tests the
 * connection, offering to save anyway when that fails. */
function EnvironmentForm(props: {
  environment?: Environment;
  onSaved: () => void;
}) {
  const { environment: existing, onSaved } = props;
  const { pop } = useNavigation();
  const [originError, setOriginError] = useState<string>();
  const [tokenError, setTokenError] = useState<string>();
  const [pairingError, setPairingError] = useState<string>();
  const [saving, setSaving] = useState(false);

  async function save(values: FormValues) {
    const name = values.name.trim();
    const pairingText = values.pairingLink.trim();
    const pairing = pairingText ? parsePairingLink(pairingText) : undefined;
    if (pairingText && !pairing) {
      setPairingError(
        "Paste the t3code://pair link, the https://…/pair#token=… link, or the code itself.",
      );
      return;
    }
    // A pairing link names its server, so the origin can be left for it to fill in.
    const origin = trimOrigin(values.origin) || pairing?.origin || "";
    if (!origin) {
      setOriginError("Enter the server's address.");
      return;
    }
    const problem = originProblem(origin);
    if (problem) {
      setOriginError(problem);
      return;
    }
    let token = values.token.trim();
    if (!token && !pairing) {
      setTokenError("Paste a token, or a pairing link below.");
      return;
    }

    setSaving(true);
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: `Checking ${hostOf(origin)}`,
    });
    const fail = (title: string, message?: string) => {
      toast.style = Toast.Style.Failure;
      toast.title = title;
      toast.message = message;
      setSaving(false);
    };

    try {
      const others = (await loadEnvironments()).filter(
        (other) => other.key !== existing?.key,
      );
      const sameOrigin = others.find((other) => other.origin === origin);
      if (sameOrigin) {
        setOriginError("This address is already listed.");
        fail(`Already added as ${await environmentLabel(sameOrigin)}`);
        return;
      }
      // Checked before a pairing link is spent on a server that is already listed.
      const id = await environmentIdAt(origin);
      if (id) {
        const ids = await Promise.all(
          others.map((other) => environmentIdAt(other.origin)),
        );
        const duplicate = others.find((_, index) => ids[index] === id);
        if (duplicate) {
          const label = await environmentLabel(duplicate);
          setOriginError(`This is the same T3 Code server as ${label}.`);
          fail(`Already added as ${label}`);
          return;
        }
      }

      let pairedUntil: Date | undefined;
      let readOnly = false;
      if (pairing) {
        toast.title = `Pairing with ${hostOf(origin)}`;
        try {
          const exchanged = await exchangePairingCredential(
            origin,
            pairing.credential,
          );
          if (!exchanged.scopes.includes("orchestration:read")) {
            fail(
              "The pairing link cannot read threads",
              `It granted ${exchanged.scopes.join(", ") || "nothing"}. Create one with the orchestration:read scope.`,
            );
            return;
          }
          token = exchanged.token;
          pairedUntil = exchanged.expiresAt;
          // Reading still works, so a link without operate is accepted and said so.
          readOnly = !exchanged.scopes.includes("orchestration:operate");
        } catch (error) {
          setPairingError(errorMessage(error));
          fail(`Could not pair with ${hostOf(origin)}`, errorMessage(error));
          return;
        }
      }

      const candidate: Environment = {
        key: existing?.key ?? randomUUID(),
        name,
        origin,
        token,
      };
      let check: ConnectionCheck | undefined;
      try {
        check = await checkConnection(candidate);
      } catch (error) {
        const saveAnyway = await confirmAlert({
          title: `${displayName(candidate)} ${failureSummary(error)}`,
          message: `${errorMessage(error)}\n\nSave it anyway? Its row will show the problem until it is fixed.`,
          primaryAction: { title: "Save Anyway" },
        });
        if (!saveAnyway) {
          fail(
            `${displayName(candidate)} ${failureSummary(error)}`,
            errorMessage(error),
          );
          return;
        }
      }

      await changeStored((list) =>
        list.some((entry) => entry.key === candidate.key)
          ? list.map((entry) =>
              entry.key === candidate.key ? candidate : entry,
            )
          : [...list, candidate],
      );
      toast.style = Toast.Style.Success;
      toast.title = `${existing ? "Saved" : "Added"} ${displayName(candidate, check)}`;
      toast.message = [
        check ? connectionSummary(check) : undefined,
        pairedUntil
          ? `paired until ${pairedUntil.toLocaleDateString()}`
          : undefined,
        readOnly ? "read only, so thread actions will be refused" : undefined,
      ]
        .filter(Boolean)
        .join(" · ");
      onSaved();
      pop();
    } catch (error) {
      fail("Could not save the environment", errorMessage(error));
    }
  }

  return (
    <Form
      isLoading={saving}
      navigationTitle={existing ? "Edit Environment" : "Add Environment"}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title={existing ? "Save Environment" : "Add Environment"}
            icon={existing ? Icon.Checkmark : Icon.Plus}
            onSubmit={save}
          />
          <Action.CopyToClipboard
            title="Copy Token Command"
            content={TOKEN_COMMAND}
          />
        </ActionPanel>
      }
    >
      <Form.Description
        title="Another Computer"
        text={`Run this on the computer running T3 Code and paste the token it prints:\n\n${TOKEN_COMMAND}\n\nThe token only travels over https or to a loopback address. For a Mac on your tailnet, tailscale serve gives it an https address.`}
      />
      <Form.TextField
        id="name"
        title="Name"
        placeholder="Mac"
        info="Shown next to this server's threads and projects. Empty uses the server's own name."
        defaultValue={existing?.name}
      />
      <Form.TextField
        id="origin"
        title="Server Origin"
        placeholder="https://mac.tailnet-name.ts.net"
        info="https://, or http:// to a loopback address only."
        defaultValue={existing?.origin}
        error={originError}
        onChange={() => setOriginError(undefined)}
      />
      <Form.PasswordField
        id="token"
        title="Access Token"
        placeholder="Paste the token printed on that computer"
        defaultValue={existing?.token}
        error={tokenError}
        onChange={() => setTokenError(undefined)}
      />
      <Form.Separator />
      <Form.TextField
        id="pairingLink"
        title="Pairing Link"
        placeholder="Optional, instead of a token"
        info="A link or code from t3 auth pairing create on that computer, used once to issue a token with the read and operate scopes. That token lasts 30 days, after which you pair again or paste a 365-day token."
        error={pairingError}
        onChange={() => setPairingError(undefined)}
      />
    </Form>
  );
}
