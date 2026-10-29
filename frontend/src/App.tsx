import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import {
  Activity,
  AudioLines,
  BarChart3,
  FileText,
  Menu,
  Plus,
  Search,
  Settings,
  Sparkles,
  Upload,
  Users,
  X,
} from "lucide-react";
import { ThemeToggle, useTheme } from "./components/ui";
import { CommandPalette, type PaletteAction } from "./components/CommandPalette";
import { JobsIndicator, useJobsSnapshot } from "./components/JobsIndicator";
import { SpeakerWithStats, isGenericSpeakerLabel, PlaudStatus, formatDate } from "./lib/common";
import { ChangelogModal } from "./views/AppModals";
import { MeetingsListView } from "./views/MeetingsList";
import { MeetingDetailView } from "./views/MeetingDetail";
import { UploadAudioModal } from "./views/meetingModals";
import { SpeakersListView } from "./views/People";
import { TemplatesListView } from "./views/Templates";
import { UsageView } from "./views/Usage";
import { ActivityView, type ActivityTab } from "./views/Activity";
import { SettingsView, isSettingsSection, type SettingsSection } from "./views/Settings";

type TabKey = "meetings" | "speakers" | "templates" | "activity" | "usage" | "settings";

interface Route {
  tab: TabKey;
  meetingId: string | null;
  activityTab: ActivityTab;
  settingsSection: SettingsSection;
}

const DEFAULT_ROUTE: Route = { tab: "meetings", meetingId: null, activityTab: "jobs", settingsSection: "general" };

export function parseLocation(pathname: string): Route {
  const clean = pathname.replace(/^\/+|\/+$/g, "");
  const [head, rest = ""] = clean.split(/\/(.*)/s);

  switch (head) {
    case "":
    case "meetings":
      return { ...DEFAULT_ROUTE, meetingId: rest.trim() || null };
    case "people":
    case "speakers":
      return { ...DEFAULT_ROUTE, tab: "speakers" };
    case "templates":
      return { ...DEFAULT_ROUTE, tab: "templates" };
    case "usage":
      return { ...DEFAULT_ROUTE, tab: "usage" };
    case "activity":
      return { ...DEFAULT_ROUTE, tab: "activity", activityTab: rest === "logs" ? "logs" : "jobs" };
    // Legacy paths from the old tab bar and the hidden queue page.
    case "logs":
      return { ...DEFAULT_ROUTE, tab: "activity", activityTab: "logs" };
    case "debug":
      return { ...DEFAULT_ROUTE, tab: "activity", activityTab: "jobs" };
    case "backup":
    case "backups":
      return { ...DEFAULT_ROUTE, tab: "settings", settingsSection: "data" };
    case "settings":
      return { ...DEFAULT_ROUTE, tab: "settings", settingsSection: isSettingsSection(rest) ? rest : "general" };
    default:
      return DEFAULT_ROUTE;
  }
}

const PRIMARY_NAV: { key: TabKey; path: string; label: string; icon: ReactElement }[] = [
  { key: "meetings", path: "/meetings", label: "Meetings", icon: <AudioLines className="h-4 w-4" aria-hidden="true" /> },
  { key: "speakers", path: "/people", label: "People", icon: <Users className="h-4 w-4" aria-hidden="true" /> },
  { key: "templates", path: "/templates", label: "Templates", icon: <FileText className="h-4 w-4" aria-hidden="true" /> },
];

const WORKSPACE_NAV: typeof PRIMARY_NAV = [
  { key: "activity", path: "/activity", label: "Activity", icon: <Activity className="h-4 w-4" aria-hidden="true" /> },
  { key: "usage", path: "/usage", label: "Usage", icon: <BarChart3 className="h-4 w-4" aria-hidden="true" /> },
];

function NavLink({
  href,
  active,
  icon,
  label,
  trailing,
  onNavigate,
}: {
  href: string;
  active: boolean;
  icon: ReactElement;
  label: string;
  trailing?: ReactNode;
  onNavigate: (path: string) => void;
}): ReactElement {
  return (
    <a
      href={href}
      aria-current={active ? "page" : undefined}
      onClick={(e) => {
        e.preventDefault();
        onNavigate(href);
      }}
      className={`flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm ${
        active ? "bg-active font-medium text-base-content" : "text-base-content/70 hover:bg-hover hover:text-base-content"
      }`}
    >
      <span className={active ? "text-base-content" : "text-base-content/55"}>{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing != null && <span className="text-xs text-base-content/45">{trailing}</span>}
    </a>
  );
}

export function App(): ReactElement {
  const [route, setRoute] = useState<Route>(() => parseLocation(typeof window !== "undefined" ? window.location.pathname : "/"));
  const { tab: activeTab, meetingId: selectedMeetingId } = route;

  // Global speakers cache
  const [knownSpeakers, setKnownSpeakers] = useState<SpeakerWithStats[]>([]);
  const [plaudStatus, setPlaudStatus] = useState<PlaudStatus | null>(null);

  const [showChangelogModal, setShowChangelogModal] = useState(false);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Bumped after an app-level upload so the meetings list reloads.
  const [meetingsVersion, setMeetingsVersion] = useState(0);

  const jobsSnapshot = useJobsSnapshot();
  const { theme, setPreference } = useTheme();

  const isTabActive = (key: TabKey) => (key === "meetings" ? activeTab === "meetings" && !selectedMeetingId : activeTab === key);

  const navigate = useCallback((path: string) => {
    setRoute(parseLocation(path));
    setSidebarOpen(false);
    if (typeof window !== "undefined" && window.location.pathname !== path) {
      window.history.pushState({}, "", path);
    }
    window.scrollTo({ top: 0 });
  }, []);

  useEffect(() => {
    const handlePopState = () => setRoute(parseLocation(window.location.pathname));
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
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
        setPlaudStatus((await res.json()) as PlaudStatus);
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    void refreshSpeakers();
    void refreshPlaudStatus();
  }, []);

  const selectMeeting = useCallback((id: string) => navigate(`/meetings/${id}`), [navigate]);

  const paletteActions = useMemo<PaletteAction[]>(
    () => [
      { id: "upload", label: "Upload audio", run: () => setShowUploadModal(true) },
      { id: "people", label: "Go to People", run: () => navigate("/people") },
      { id: "templates", label: "Go to Templates", run: () => navigate("/templates") },
      { id: "activity", label: "Go to Activity", run: () => navigate("/activity") },
      { id: "logs", label: "View logs", run: () => navigate("/activity/logs") },
      { id: "usage", label: "Go to Usage", run: () => navigate("/usage") },
      { id: "settings", label: "Open Settings", run: () => navigate("/settings") },
      { id: "ai", label: "Settings: AI models", run: () => navigate("/settings/ai") },
      { id: "plaud", label: "Settings: Plaud and integrations", run: () => navigate("/settings/integrations") },
      { id: "backup", label: "Settings: Data & backups", run: () => navigate("/settings/data") },
      {
        id: "theme",
        label: theme === "olive-dark" ? "Switch to light theme" : "Switch to dark theme",
        run: () => setPreference(theme === "olive-dark" ? "light" : "dark"),
      },
      { id: "changelog", label: "What's new", run: () => setShowChangelogModal(true) },
    ],
    [navigate, theme, setPreference]
  );

  const sidebar = (
    <div className="flex h-full flex-col gap-1 px-2 py-3">
      <div className="flex items-center gap-2 px-2 pb-2">
        <a
          href="/meetings"
          onClick={(e) => {
            e.preventDefault();
            navigate("/meetings");
          }}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 hover:bg-hover"
        >
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary text-xs font-bold text-primary-content">O</span>
          <span className="truncate font-semibold">Olive</span>
        </a>
        <button
          type="button"
          aria-label="Close menu"
          onClick={() => setSidebarOpen(false)}
          className="btn btn-ghost btn-sm btn-square lg:hidden"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      <button
        type="button"
        onClick={() => setPaletteOpen(true)}
        className="flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm text-base-content/70 hover:bg-hover hover:text-base-content"
      >
        <Search className="h-4 w-4 text-base-content/55" aria-hidden="true" />
        <span className="flex-1 text-left">Search</span>
        <kbd className="hidden rounded border border-base-300 px-1 text-[11px] text-base-content/50 sm:inline">⌘K</kbd>
      </button>
      <button
        type="button"
        onClick={() => setShowUploadModal(true)}
        className="flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm text-base-content/70 hover:bg-hover hover:text-base-content"
      >
        <Plus className="h-4 w-4 text-base-content/55" aria-hidden="true" />
        <span>Upload audio</span>
      </button>

      <nav aria-label="Primary" className="mt-3 flex flex-col gap-0.5">
        {PRIMARY_NAV.map((item) => (
          <NavLink
            key={item.key}
            href={item.path}
            active={isTabActive(item.key) || (item.key === "meetings" && !!selectedMeetingId)}
            icon={item.icon}
            label={item.label}
            trailing={item.key === "speakers" && knownSpeakers.length > 0 ? knownSpeakers.length : undefined}
            onNavigate={(path) => {
              navigate(path);
              if (item.key === "speakers") void refreshSpeakers();
            }}
          />
        ))}
        <span className="mt-4 px-2.5 pb-1 text-xs font-medium text-base-content/50">Workspace</span>
        {WORKSPACE_NAV.map((item) => (
          <NavLink key={item.key} href={item.path} active={isTabActive(item.key)} icon={item.icon} label={item.label} onNavigate={navigate} />
        ))}
      </nav>

      <div className="mt-auto flex flex-col gap-2 pt-4">
        <JobsIndicator snapshot={jobsSnapshot} onOpenActivity={() => navigate("/activity")} onSelectMeeting={selectMeeting} />
        <a
          href="/settings/integrations"
          onClick={(e) => {
            e.preventDefault();
            navigate("/settings/integrations");
            void refreshPlaudStatus();
          }}
          className="flex items-center gap-2 rounded-md px-2.5 py-1 text-xs text-base-content/60 hover:bg-hover"
        >
          <span className={`h-2 w-2 shrink-0 rounded-full ${plaudStatus?.connected ? "bg-success" : "bg-warning"}`} aria-hidden="true" />
          <span className="truncate">
            {plaudStatus?.connected
              ? `Plaud synced${plaudStatus.lastPollAt ? ` · ${formatDate(plaudStatus.lastPollAt)}` : ""}`
              : "Plaud not connected"}
          </span>
        </a>
        <div className="flex flex-col gap-0.5 border-t border-divider pt-2">
          <NavLink
            href="/settings"
            active={activeTab === "settings"}
            icon={<Settings className="h-4 w-4" aria-hidden="true" />}
            label="Settings"
            onNavigate={navigate}
          />
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setShowChangelogModal(true)}
              className="flex h-8 flex-1 items-center gap-2.5 rounded-md px-2.5 text-sm text-base-content/70 hover:bg-hover hover:text-base-content"
            >
              <Sparkles className="h-4 w-4 text-base-content/55" aria-hidden="true" />
              What's new
            </button>
            <ThemeToggle />
          </div>
        </div>
      </div>
    </div>
  );

  const mobileNav: { key: string; label: string; icon: ReactElement; active: boolean; onClick: () => void }[] = [
    { key: "meetings", label: "Meetings", icon: <AudioLines className="h-5 w-5" aria-hidden="true" />, active: activeTab === "meetings", onClick: () => navigate("/meetings") },
    { key: "people", label: "People", icon: <Users className="h-5 w-5" aria-hidden="true" />, active: activeTab === "speakers", onClick: () => navigate("/people") },
    { key: "upload", label: "Upload", icon: <Upload className="h-5 w-5" aria-hidden="true" />, active: false, onClick: () => setShowUploadModal(true) },
    { key: "activity", label: "Activity", icon: <Activity className="h-5 w-5" aria-hidden="true" />, active: activeTab === "activity", onClick: () => navigate("/activity") },
    { key: "settings", label: "Settings", icon: <Settings className="h-5 w-5" aria-hidden="true" />, active: activeTab === "settings", onClick: () => navigate("/settings") },
  ];

  const pageTitle =
    activeTab === "activity" ? "Activity" : activeTab === "usage" ? "Usage" : activeTab === "settings" ? "Settings" : null;

  return (
    <div className="min-h-screen w-full overflow-x-clip bg-base-100 text-base-content selection:bg-primary/25">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 border-r border-divider bg-base-200 lg:block">{sidebar}</aside>

      {/* Mobile/tablet sidebar drawer */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button type="button" aria-label="Close menu" className="absolute inset-0 bg-black/40" onClick={() => setSidebarOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 max-w-[85vw] bg-base-200 shadow-pop pt-safe">{sidebar}</aside>
        </div>
      )}

      {/* Mobile header */}
      <header className="sticky top-0 z-20 flex items-center gap-1 border-b border-divider bg-base-100/90 px-2 py-1.5 backdrop-blur pt-safe lg:hidden">
        <button type="button" aria-label="Open menu" onClick={() => setSidebarOpen(true)} className="btn btn-ghost btn-square">
          <Menu className="h-5 w-5" aria-hidden="true" />
        </button>
        <span className="flex-1" />
        <JobsIndicator
          snapshot={jobsSnapshot}
          variant="pill"
          onOpenActivity={() => navigate("/activity")}
          onSelectMeeting={selectMeeting}
        />
        <button type="button" aria-label="Search" onClick={() => setPaletteOpen(true)} className="btn btn-ghost btn-square">
          <Search className="h-5 w-5" aria-hidden="true" />
        </button>
      </header>

      <main className="min-w-0 lg:pl-60">
        <div
          className={`mx-auto w-full min-w-0 px-4 pt-5 pb-[calc(6rem+env(safe-area-inset-bottom))] sm:px-8 lg:pb-16 ${
            selectedMeetingId ? "max-w-none lg:px-0 lg:pt-0" : "max-w-6xl lg:px-14 lg:pt-10"
          }`}
        >
          {pageTitle && <h1 className="mb-6 text-3xl font-bold tracking-tight sm:text-4xl">{pageTitle}</h1>}
          {selectedMeetingId ? (
            <MeetingDetailView
              meetingId={selectedMeetingId}
              knownSpeakers={knownSpeakers}
              onBack={() => navigate("/meetings")}
              onDeleted={() => navigate("/meetings")}
              onSpeakerUpdated={() => void refreshSpeakers()}
            />
          ) : activeTab === "meetings" ? (
            <MeetingsListView key={meetingsVersion} onSelectMeeting={selectMeeting} />
          ) : activeTab === "speakers" ? (
            <SpeakersListView speakers={knownSpeakers} onRefresh={() => void refreshSpeakers()} onSelectMeeting={selectMeeting} />
          ) : activeTab === "templates" ? (
            <TemplatesListView />
          ) : activeTab === "activity" ? (
            <ActivityView tab={route.activityTab} onNavigateTab={(t) => navigate(t === "logs" ? "/activity/logs" : "/activity")} onSelectMeeting={selectMeeting} />
          ) : activeTab === "usage" ? (
            <UsageView onSelectMeeting={selectMeeting} />
          ) : (
            <SettingsView
              section={route.settingsSection}
              onNavigateSection={(s) => navigate(`/settings/${s}`)}
              plaudStatus={plaudStatus}
              onRefreshPlaud={() => void refreshPlaudStatus()}
              onSettingsSaved={() => undefined}
              onRestoreComplete={() => void refreshSpeakers()}
            />
          )}
        </div>
      </main>

      {/* Mobile bottom nav */}
      <nav aria-label="Primary" className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-divider bg-base-100 px-1 pt-1.5 pb-safe lg:hidden">
        {mobileNav.map((item) => (
          <button
            key={item.key}
            type="button"
            aria-current={item.active ? "page" : undefined}
            onClick={item.onClick}
            className={`flex min-h-[52px] flex-col items-center justify-center gap-0.5 text-[11px] ${item.active ? "font-semibold text-primary" : "text-base-content/60"}`}
          >
            <span className={`flex h-7 w-10 items-center justify-center rounded-full ${item.active ? "bg-primary/15" : ""}`}>{item.icon}</span>
            {item.label}
          </button>
        ))}
      </nav>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} onSelectMeeting={selectMeeting} actions={paletteActions} />

      {showUploadModal && (
        <UploadAudioModal
          onClose={() => setShowUploadModal(false)}
          onUploaded={(id) => {
            setShowUploadModal(false);
            setMeetingsVersion((v) => v + 1);
            selectMeeting(id);
          }}
        />
      )}

      {showChangelogModal && <ChangelogModal onClose={() => setShowChangelogModal(false)} />}
    </div>
  );
}
