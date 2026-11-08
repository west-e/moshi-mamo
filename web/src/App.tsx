import { useEffect, useState } from "react";
import { DevPanel } from "./DevPanel.tsx";
import { UserScreen } from "./UserScreen.tsx";
import { VIEW_CHANNEL, useCallSession } from "./useCallSession.ts";
import type { UserView } from "./userView.ts";

const EMPTY_VIEW: UserView = { started: false, latched: null, cleared: false, problem: null, evaluating: false, topSignal: null, recording: false, directive: false };

function useRoute() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return hash.replace(/^#\/?/, "");
}

// #/user: 別タブの開発画面から表示状態だけを受け取る利用者画面
function RemoteUserScreen() {
  const [view, setView] = useState<UserView>(EMPTY_VIEW);
  useEffect(() => {
    const ch = new BroadcastChannel(VIEW_CHANNEL);
    ch.onmessage = (e) => setView(e.data as UserView);
    return () => ch.close();
  }, []);
  return (
    <main className="layout-user">
      <UserScreen view={view} />
    </main>
  );
}

function Controller({ withUser }: { withUser: boolean }) {
  const session = useCallSession();
  return (
    <main className={withUser ? "layout-demo" : "layout-dev"}>
      {withUser && <UserScreen view={session.view} />}
      <DevPanel session={session} />
    </main>
  );
}

export function App() {
  const route = useRoute();
  if (route === "user") return <RemoteUserScreen />;
  return <Controller withUser={route !== "dev"} />;
}
