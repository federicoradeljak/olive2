import { useEffect, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { Ellipsis, Settings, Sparkles } from "lucide-react";
import { ThemeToggle } from "./components/ui";
import { SpeakerWithStats, isGenericSpeakerLabel, PlaudStatus } from "./lib/common";
import { MeetingChatPanel } from "./views/MeetingChat";
import { Modal, ChangelogModal, PlaudModal } from "./views/AppModals";
import { MeetingsListView } from "./views/MeetingsList";
import { MeetingDetailView } from "./views/MeetingDetail";
import { SpeakersListView } from "./views/People";
import { TemplatesListView } from "./views/Templates";
import { LlmSettingsModal } from "./views/LlmSettings";
import { UsageView } from "./views/Usage";
import { LogsView } from "./views/Logs";
import { BackupRestoreView } from "./views/Backup";

export type TabKey = "meetings" | "speakers" | "templates" | "logs" | "backup" | "usage";

export function parseLocation(pathname: string): { tab: TabKey; meetingId: string | null } {
  const clean = pathname.replace(/^\/+|\/+$/g, "");
  if (!clean || clean === "meetings") {
    return { tab: "meetings", meetingId: null };
  }

  if (clean.startsWith("meetings/")) {
    const id = clean.slice("meetings/".length).trim();
    return { tab: "meetings", meetingId: id || null };
  }

  if (clean === "people" || clean === "speakers") {
    return { tab: "speakers", meetingId: null };
  }

  if (clean === "templates") {
    return { tab: "templates", meetingId: null };
  }

  if (clean === "logs") {
    return { tab: "logs", meetingId: null };
  }

  if (clean === "backup" || clean === "backups") {
    return { tab: "backup", meetingId: null };
  }

  if (clean === "usage") {
    return { tab: "usage", meetingId: null };
  }

  return { tab: "meetings", meetingId: null };
}

export const NAV_TABS: { key: TabKey; path: string; label: string }[] = [
  { key: "meetings", path: "/meetings", label: "Meetings" },
  { key: "speakers", path: "/people", label: "People" },
  { key: "templates", path: "/templates", label: "Templates" },
  { key: "logs", path: "/logs", label: "Logs" },
  { key: "backup", path: "/backup", label: "Backup" },
  { key: "usage", path: "/usage", label: "Usage" },
];

export const TAB_ICON_CONTENT: Record<TabKey, ReactNode> = {
  meetings: (
    <>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </>
  ),
  speakers: (
    <>
      <circle cx="9" cy="7" r="4" />
      <path d="M2 21v-2a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v2" />
    </>
  ),
  templates: (
    <>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M8 8h8M8 12h8M8 16h5" />
    </>
  ),
  logs: <path d="M4 6h16M4 12h16M4 18h10" />,
  backup: (
    <>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </>
  ),
  usage: <path d="M4 20V10M10 20V4M16 20v-7M2 20h20" />,
};

export function TabIcon({ name }: { name: TabKey }): ReactElement {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {TAB_ICON_CONTENT[name]}
    </svg>
  );
}

export function App(): ReactElement {
  const initialRoute = parseLocation(typeof window !== "undefined" ? window.location.pathname : "/");
  const [activeTab, setActiveTab] = useState<TabKey>(initialRoute.tab);
  const [selectedMeetingId, setSelectedMeetingId] = useState<string | null>(initialRoute.meetingId);

  // Global speakers cache
  const [knownSpeakers, setKnownSpeakers] = useState<SpeakerWithStats[]>([]);

  // Plaud status
  const [plaudStatus, setPlaudStatus] = useState<PlaudStatus | null>(null);
  const [showPlaudModal, setShowPlaudModal] = useState(false);

  // LLM status & settings
  const [llmConfig, setLlmConfig] = useState<{ defaultProvider: string; defaultModel: string } | null>(null);
  const [showLlmModal, setShowLlmModal] = useState(false);

  // Changelog
  const [showChangelogModal, setShowChangelogModal] = useState(false);

  // Meeting chat drawer (App-level so it overlays nav + content via drawer-side)
  const [chatOpen, setChatOpen] = useState(false);
  const [chatTitle, setChatTitle] = useState("");
  const [showMoreNav, setShowMoreNav] = useState(false);

  const isTabActive = (key: TabKey) => (key === "meetings" ? activeTab === "meetings" && !selectedMeetingId : activeTab === key);

  const navigate = (path: string) => {
    const route = parseLocation(path);
    setActiveTab(route.tab);
    setSelectedMeetingId(route.meetingId);
    setChatOpen(false);
    setShowMoreNav(false);
    if (typeof window !== "undefined" && window.location.pathname !== path) {
      window.history.pushState({}, "", path);
    }
  };

  useEffect(() => {
    const handlePopState = () => {
      const route = parseLocation(window.location.pathname);
      setActiveTab(route.tab);
      setSelectedMeetingId(route.meetingId);
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const refreshSpeakers = async () => {
    try {
      const res = await fetch("/api/speakers");
      if (res.ok) {
        const data = (await res.json()) as { speakers: SpeakerWithStats[] };
        setKnownSpeakers(data.speakers.filter((s) => !isGenericSpeakerLabel(s.name)));
      }
    } catch {
      // ignore
    }
  };

  const refreshPlaudStatus = async () => {
    try {
      const res = await fetch("/api/plaud/status");
      if (res.ok) {
        const data = (await res.json()) as PlaudStatus;
        setPlaudStatus(data);
      }
    } catch {
      // ignore
    }
  };

  const refreshLlmConfig = async () => {
    try {
      const res = await fetch("/api/llm/config");
      if (res.ok) {
        const data = await res.json();
        setLlmConfig(data);
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    void refreshSpeakers();
    void refreshPlaudStatus();
    void refreshLlmConfig();
  }, []);

  return (
    <div className="drawer drawer-end w-full">
      <input
        id="olive-chat-drawer"
        type="checkbox"
        className="drawer-toggle"
        checked={chatOpen}
        onChange={(e) => setChatOpen(e.target.checked)}
      />
      <div className="drawer-content min-h-screen bg-base-100 text-base-content selection:bg-primary selection:text-primary-content w-full overflow-x-clip">
      <nav className="border-b border-base-300 bg-base-200/80 backdrop-blur sticky top-0 z-30 px-3 sm:px-6 py-2.5 sm:py-3.5 w-full">
        <div className="mx-auto flex max-w-6xl flex-nowrap items-center justify-between gap-2 sm:gap-4">
          <div className="flex min-w-0 items-center gap-3 sm:gap-4 lg:gap-6">
            <a
              href="/meetings"
              onClick={(e) => {
                e.preventDefault();
                navigate("/meetings");
              }}
              className="flex shrink-0 items-center gap-2 cursor-pointer hover:opacity-90 transition"
            >
              <span className="flex h-7 w-7 sm:h-8 sm:w-8 items-center justify-center rounded-lg bg-primary font-bold text-primary-content text-sm sm:text-base">
                O
              </span>
              <span className="text-lg sm:text-xl font-semibold tracking-tight">Olive</span>
            </a>
            <div className="hidden sm:flex min-w-0 flex-nowrap items-center gap-0.5 overflow-x-auto rounded-lg bg-base-200 p-1 text-xs lg:text-sm font-medium">
              {NAV_TABS.map((tab) => (
                <a
                  key={tab.key}
                  href={tab.path}
                  onClick={(e) => {
                    e.preventDefault();
                    navigate(tab.path);
                    if (tab.key === "speakers") void refreshSpeakers();
                  }}
                  className={`shrink-0 whitespace-nowrap rounded-field px-2 lg:px-3 py-1.5 transition ${
                    isTabActive(tab.key) ? "bg-base-100 text-primary shadow" : "text-base-content/60 hover:text-base-content"
                  }`}
                >
                  {tab.key === "speakers" ? `People (${knownSpeakers.length})` : tab.label}
                </a>
              ))}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setShowChangelogModal(true)}
              title="What's new in Olive"
              className="btn btn-ghost btn-sm shrink-0"
            >
              <span aria-hidden="true" className="inline-flex"><Sparkles className="h-3.5 w-3.5" aria-hidden="true" /></span>
              <span className="hidden md:inline">What's New</span>
            </button>
            <button
              type="button"
              onClick={() => setShowLlmModal(true)}
              className="btn btn-ghost btn-sm max-w-[110px] lg:max-w-[150px] xl:max-w-none"
            >
              <span className="h-2 w-2 rounded-full bg-accent shrink-0" />
              <span className="truncate">AI: {llmConfig ? `${llmConfig.defaultProvider}/${llmConfig.defaultModel}` : "Config"}</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setShowPlaudModal(true);
                void refreshPlaudStatus();
              }}
              className={`btn btn-sm shrink-0 ${
                plaudStatus?.connected
                  ? "border-primary/30 bg-primary/10 text-primary hover:bg-primary/20"
                  : "border-warning/30 bg-warning/10 text-warning hover:bg-warning/20"
              }`}
            >
              <span className={`h-2 w-2 rounded-full shrink-0 ${plaudStatus?.connected ? "bg-primary" : "bg-warning"}`} />
              <span>{plaudStatus?.connected ? "Plaud" : "Connect"}</span>
            </button>
            <ThemeToggle />
          </div>
        </div>
      </nav>

      <nav
        aria-label="Primary"
        className="dock dock-md z-30 pb-safe sm:hidden"
      >
        {(NAV_TABS.filter((t) => t.key === "meetings" || t.key === "speakers" || t.key === "templates" || t.key === "usage")).map((tab) => {
          const active = isTabActive(tab.key);
          return (
            <button
              key={tab.key}
              type="button"
              aria-current={active ? "page" : undefined}
              onClick={() => {
                setShowMoreNav(false);
                navigate(tab.path);
                if (tab.key === "speakers") void refreshSpeakers();
              }}
              className={active ? "dock-active" : ""}
            >
              <TabIcon name={tab.key} />
              <span className="dock-label">{tab.key === "speakers" ? `People${knownSpeakers.length > 0 ? ` (${knownSpeakers.length})` : ""}` : tab.label}</span>
            </button>
          );
        })}
        <button
          type="button"
          aria-expanded={showMoreNav}
          aria-label="More sections"
          onClick={() => setShowMoreNav((v) => !v)}
          className={activeTab === "logs" || activeTab === "backup" ? "dock-active" : ""}
        >
          <Ellipsis className="h-5 w-5" aria-hidden="true" />
          <span className="dock-label">More</span>
        </button>
      </nav>
      {showMoreNav && (
        <div className="fixed inset-x-4 bottom-20 z-40 sm:hidden">
          <ul className="menu rounded-box border border-base-300 bg-base-100 p-2 shadow-lg">
            {(NAV_TABS.filter((t) => t.key === "logs" || t.key === "backup")).map((tab) => (
              <li key={tab.key}>
                <a
                  href={tab.path}
                  aria-current={isTabActive(tab.key) ? "page" : undefined}
                  onClick={(e) => {
                    e.preventDefault();
                    setShowMoreNav(false);
                    navigate(tab.path);
                  }}
                  className={isTabActive(tab.key) ? "menu-active" : ""}
                >
                  <TabIcon name={tab.key} />
                  {tab.label}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      <main className="mx-auto max-w-6xl px-3.5 sm:px-6 pt-4 sm:pt-8 pb-[calc(6rem+env(safe-area-inset-bottom))] sm:pb-8 w-full overflow-x-clip min-w-0">
        {selectedMeetingId ? (
          <MeetingDetailView
            meetingId={selectedMeetingId}
            knownSpeakers={knownSpeakers}
            onBack={() => navigate("/meetings")}
            onDeleted={() => navigate("/meetings")}
            onSpeakerUpdated={() => void refreshSpeakers()}
            onChatOpenChange={setChatOpen}
            onChatTitle={setChatTitle}
          />
        ) : activeTab === "meetings" ? (
          <MeetingsListView onSelectMeeting={(id) => navigate(`/meetings/${id}`)} />
        ) : activeTab === "speakers" ? (
          <SpeakersListView
            speakers={knownSpeakers}
            onRefresh={() => void refreshSpeakers()}
            onSelectMeeting={(id) => navigate(`/meetings/${id}`)}
          />
        ) : activeTab === "templates" ? (
          <TemplatesListView />
        ) : activeTab === "logs" ? (
          <LogsView
            onSelectMeeting={(id) => navigate(`/meetings/${id}`)}
          />
        ) : activeTab === "usage" ? (
          <UsageView onSelectMeeting={(id) => navigate(`/meetings/${id}`)} />
        ) : (
          <BackupRestoreView
            onRestoreComplete={() => {
              void refreshSpeakers();
              void refreshLlmConfig();
            }}
          />
        )}
      </main>

      {/* Changelog Modal */}
      {showChangelogModal && (
        <ChangelogModal onClose={() => setShowChangelogModal(false)} />
      )}

      {/* Plaud Auth & Sync Modal */}
      {showPlaudModal && (
        <PlaudModal
          status={plaudStatus}
          onClose={() => setShowPlaudModal(false)}
          onRefreshStatus={() => void refreshPlaudStatus()}
        />
      )}

      {/* LLM Provider & Model Settings Modal */}
      {showLlmModal && (
        <LlmSettingsModal
          onClose={() => setShowLlmModal(false)}
          onSaved={() => {
            setShowLlmModal(false);
            void refreshLlmConfig();
          }}
        />
      )}
      </div>
      <div className="drawer-side z-50">
        <label htmlFor="olive-chat-drawer" aria-label="Close chat" className="drawer-overlay" />
        <div className="min-h-full w-full max-w-xl bg-base-100 shadow-2xl">
          {chatOpen && selectedMeetingId && (
            <MeetingChatPanel
              meetingId={selectedMeetingId}
              meetingTitle={chatTitle || "Meeting"}
              onClose={() => setChatOpen(false)}
            />
          )}
        </div>
      </div>
    </div>
  );
}
