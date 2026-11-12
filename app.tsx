import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  definePluginApp,
  experimental_Diff as Diff,
  experimental_saveFile,
  experimental_SourceCode as SourceCode,
  useBbNavigate,
  useRealtime,
  useRpc,
  type ExperimentalThreadActionTabProps,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import type { RemoteEntry, rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { createTwoFilesPatch } from "diff";
import { CodeEditor } from "./editor";
import { hasConflictMarkers, mergeThreeWay } from "./merge";

const PANEL_PATH = "ssh";
const HOST_KEY = "bb-ssh:host";
const DIR_CHANGED = "dir-changed";
const LINKS_CHANGED = "links-changed";
const SYNC_CHANGED = "sync-changed";
const DIFFERS_COLOR = "#d9a032";

type LocalState = "same" | "differs" | "missing";
const MAX_TRANSFER_BYTES = 20 * 1024 * 1024;

let pageTerminalOpener: ((options: { terminalId: string }) => Promise<boolean>) | null = null;

type Listing = { path: string; entries: RemoteEntry[]; truncated: boolean };
type FileDoc =
  | { kind: "text"; content: string; sha256: string; size: number }
  | { kind: "binary"; sha256: string; size: number };

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function parseSubPath(subPath: string): { host: string | null; file: string | null } {
  const segments = subPath
    .split("/")
    .filter((segment) => segment !== "")
    .map(decodeURIComponent);
  const [host, ...rest] = segments;
  return {
    host: host ?? null,
    file: rest.length === 0 ? null : `/${rest.join("/")}`,
  };
}

function joinPath(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

function parentPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

function Muted({ children }: { children: ReactNode }) {
  return <p className="px-2 py-1 text-xs text-muted-foreground">{children}</p>;
}

function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="whitespace-pre-wrap break-words px-2 py-1 text-xs text-destructive">
      {children}
    </p>
  );
}

type TreeProps = {
  host: string;
  activeFile: string | null;
  selectedDir: string | null;
  onOpen: (path: string) => void;
  onSelectDir: (path: string) => void;
};

function DirListing({
  path,
  depth,
  onResolved,
  ...tree
}: TreeProps & { path: string; depth: number; onResolved?: (path: string) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [statuses, setStatuses] = useState<Record<string, LocalState>>({});
  const [syncVersion, setSyncVersion] = useState(0);
  const resolvedPath = useRef<string | null>(null);
  useRealtime(DIR_CHANGED, (payload) => {
    const change = payload as { host?: string; dir?: string };
    if (change.host === tree.host && change.dir === resolvedPath.current) setVersion((v) => v + 1);
  });
  useRealtime(SYNC_CHANGED, (payload) => {
    if ((payload as { host?: string }).host === tree.host) setSyncVersion((v) => v + 1);
  });
  useRealtime(LINKS_CHANGED, () => setSyncVersion((v) => v + 1));
  useEffect(() => {
    let alive = true;
    rpc.call("ssh_list", { host: tree.host, path }).then(
      (result) => {
        if (!alive) return;
        resolvedPath.current = result.path;
        setListing(result);
        onResolved?.(result.path);
      },
      (cause) => alive && setError(errorText(cause)),
    );
    return () => {
      alive = false;
    };
  }, [rpc, tree.host, path, onResolved, version]);
  const listedPath = listing?.path ?? null;
  useEffect(() => {
    if (listedPath === null) return;
    let alive = true;
    rpc.call("ssh_dir_diff", { host: tree.host, path: listedPath }).then(
      (diff) => alive && setStatuses(diff.statuses),
      () => alive && setStatuses({}),
    );
    return () => {
      alive = false;
    };
  }, [rpc, tree.host, listedPath, listing, syncVersion]);
  if (error !== null) return <ErrorLine>{error}</ErrorLine>;
  if (listing === null) return <Muted>Загрузка…</Muted>;
  if (listing.entries.length === 0) return <Muted>Пусто</Muted>;
  return (
    <ul>
      {listing.entries.map((entry) => (
        <EntryRow
          key={entry.name}
          entry={entry}
          fullPath={joinPath(listing.path, entry.name)}
          depth={depth}
          localState={statuses[entry.name]}
          {...tree}
        />
      ))}
      {listing.truncated ? <Muted>Показаны первые 5000 элементов</Muted> : null}
    </ul>
  );
}

function EntryRow({
  entry,
  fullPath,
  depth,
  localState,
  ...tree
}: TreeProps & { entry: RemoteEntry; fullPath: string; depth: number; localState?: LocalState }) {
  const [open, setOpen] = useState(false);
  const isDir = entry.kind === "dir";
  const active = isDir ? tree.selectedDir === fullPath : tree.activeFile === fullPath;
  const onClick = () => {
    if (!isDir) return tree.onOpen(fullPath);
    setOpen(!open);
    tree.onSelectDir(fullPath);
  };
  return (
    <li>
      <button
        type="button"
        disabled={entry.kind === "other"}
        title={fullPath}
        onClick={onClick}
        style={{ paddingLeft: 8 + depth * 12 }}
        className={cn(
          "flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-sm hover:bg-state-hover disabled:opacity-50",
          active && "bg-state-active text-foreground",
        )}
      >
        {isDir ? (
          <Icon
            name={open ? "ChevronDown" : "ChevronRight"}
            className="size-3.5 shrink-0 text-muted-foreground"
          />
        ) : (
          <span className="size-3.5 shrink-0" />
        )}
        <Icon
          name={isDir ? (open ? "FolderOpen" : "Folder") : "File"}
          className="size-4 shrink-0 text-muted-foreground"
        />
        <span
          className={cn("min-w-0 truncate", entry.link && "italic")}
          style={localState === "differs" ? { color: DIFFERS_COLOR } : undefined}
        >
          {entry.name}
        </span>
        {localState === "differs" || localState === "missing" ? (
          <span
            className="ml-auto shrink-0 pl-1 text-xs text-muted-foreground"
            style={localState === "differs" ? { color: DIFFERS_COLOR } : undefined}
            title={
              isDir
                ? localState === "differs"
                  ? "Внутри есть файлы, которые отличаются от локальных"
                  : "Внутри есть файлы, которых нет в локальном проекте"
                : localState === "differs"
                  ? "Отличается от локального файла"
                  : "Нет в локальном проекте"
            }
            aria-label={localState === "differs" ? "отличается от локального" : "нет в проекте"}
          >
            {localState === "differs" ? "●" : "○"}
          </span>
        ) : null}
      </button>
      {isDir && open ? <DirListing path={fullPath} depth={depth + 1} {...tree} /> : null}
    </li>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Не удалось прочитать файл"));
    reader.readAsDataURL(file);
  });
}

type Link = { local: string; remote: string };

function shortHome(path: string): string {
  return path.replace(/^\/(Users|home)\/[^/]+(?=\/|$)/, "~");
}

function LinkBar({
  host,
  link,
  defaultRemote,
  onChange,
}: {
  host: string;
  link: Link | undefined;
  defaultRemote: string | null;
  onChange: (links: Record<string, Link>) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [editing, setEditing] = useState(false);
  const [local, setLocal] = useState("");
  const [remote, setRemote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = () => {
    setLocal(link?.local ?? "");
    setRemote(link?.remote ?? defaultRemote ?? "");
    setError(null);
    setEditing(true);
  };

  const submit = async (clear: boolean) => {
    if (!clear && (local.trim() === "" || !remote.trim().startsWith("/"))) {
      setError("Нужны локальная папка и полный путь удалённой папки");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await rpc.call("ssh_set_link", {
        host,
        local: clear ? "" : local.trim(),
        remote: clear ? "" : remote.trim(),
      });
      onChange(result.links);
      setEditing(false);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  if (!editing) {
    return link === undefined ? (
      <Button variant="ghost" size="sm" className="h-7 justify-start px-2 text-xs text-muted-foreground" onClick={start}>
        Связать с локальной папкой…
      </Button>
    ) : (
      <button
        type="button"
        onClick={start}
        title={`${link.local} ⇄ ${link.remote}`}
        className="flex items-center gap-1 rounded-md px-2 py-1 text-left font-mono text-xs text-muted-foreground hover:bg-state-hover"
      >
        <span className="min-w-0 flex-1 truncate">
          {shortHome(link.local)} ⇄ {link.remote}
        </span>
        <Icon name="Edit" className="size-3.5 shrink-0" />
      </button>
    );
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit(false);
      }}
      className="flex flex-col gap-1 rounded-md border border-border px-2 py-1.5"
    >
      <span className="text-xs text-muted-foreground">Локальная папка на этом Mac</span>
      <Input
        value={local}
        onChange={(event) => setLocal(event.target.value)}
        placeholder="~/Documents/dev/проект"
        aria-label="Локальная папка"
        autoFocus
        className="h-7 font-mono text-xs"
      />
      <span className="text-xs text-muted-foreground">связана с папкой на сервере</span>
      <Input
        value={remote}
        onChange={(event) => setRemote(event.target.value)}
        placeholder="/var/www/agents"
        aria-label="Удалённая папка"
        className="h-7 font-mono text-xs"
      />
      <div className="flex items-center gap-1">
        <Button type="submit" size="sm" className="h-7" disabled={busy}>
          Сохранить
        </Button>
        {link !== undefined ? (
          <Button type="button" size="sm" variant="ghost" className="h-7" disabled={busy} onClick={() => void submit(true)}>
            Отвязать
          </Button>
        ) : null}
        <Button type="button" size="sm" variant="ghost" className="h-7" disabled={busy} onClick={() => setEditing(false)}>
          Отмена
        </Button>
      </div>
      {error !== null ? <ErrorLine>{error}</ErrorLine> : null}
    </form>
  );
}

function pluralEntries(count: number): string {
  const tens = count % 100;
  const ones = count % 10;
  if (tens >= 11 && tens <= 14) return "элементов";
  if (ones === 1) return "элемент";
  if (ones >= 2 && ones <= 4) return "элемента";
  return "элементов";
}

const ThreadIdContext = createContext<string | null>(null);

function useOpenSshTerminal() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const threadId = useContext(ThreadIdContext);
  return useCallback(
    async (host: string, dir: string) => {
      const { terminalId } = await rpc.call("ssh_open_terminal", { host, dir, threadId });
      const open = threadId === null ? (pageTerminalOpener ?? navigate.experimental_openTerminal) : navigate.experimental_openTerminal;
      if (!(await open({ terminalId }))) throw new Error("bb не смог показать терминал");
    },
    [rpc, navigate, threadId],
  );
}

const NAMING = {
  file: { placeholder: "имя-файла.php", label: "Имя нового файла", submit: "Создать" },
  dir: { placeholder: "новая-папка", label: "Имя новой папки", submit: "Создать" },
  rename: { placeholder: "новое имя", label: "Новое имя папки", submit: "Переименовать" },
} as const;

function DirActions({
  host,
  dir,
  root,
  onCreated,
  onDirRenamed,
  onDirDeleted,
}: {
  host: string;
  dir: string;
  root: string | null;
  onCreated: (path: string) => void;
  onDirRenamed: (path: string) => void;
  onDirDeleted: (parent: string) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const picker = useRef<HTMLInputElement>(null);
  const openSshTerminal = useOpenSshTerminal();
  const [naming, setNaming] = useState<keyof typeof NAMING | null>(null);
  const [name, setName] = useState("");
  const isRoot = root === null || dir === root;
  const [confirmRm, setConfirmRm] = useState<{ entries: number; capped: boolean } | null>(null);
  const dirName = dir.slice(dir.lastIndexOf("/") + 1);

  const askRemoveDir = async () => {
    setNaming(null);
    setNotice(null);
    setError(null);
    setBusy("Считаю, что внутри…");
    try {
      setConfirmRm(await rpc.call("ssh_dir_info", { host, path: dir }));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  const removeDir = async () => {
    setBusy("Удаляю…");
    setError(null);
    try {
      const result = await rpc.call("ssh_rmdir", { host, path: dir });
      if (result.outcome === "missing") {
        setConfirmRm(null);
        return setError("Папки уже нет на сервере");
      }
      onDirDeleted(parentPath(dir));
    } catch (cause) {
      setConfirmRm(null);
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [replace, setReplace] = useState<{ name: string; base64: string } | null>(null);

  const label = root !== null && dir !== root && dir.startsWith(`${root === "/" ? "" : root}/`)
    ? `…${dir.slice(root === "/" ? 0 : root.length)}`
    : dir;

  const put = async (fileName: string, base64: string, overwrite: boolean) => {
    const path = joinPath(dir, fileName);
    setBusy(base64 === "" ? "Создаю…" : `Загружаю ${fileName}…`);
    setError(null);
    setNotice(null);
    try {
      const result = await rpc.call("ssh_put", { host, path, base64, overwrite });
      return { path, outcome: result.outcome };
    } finally {
      setBusy(null);
    }
  };

  const toggleNaming = (mode: keyof typeof NAMING) => {
    setNaming(naming === mode ? null : mode);
    setConfirmRm(null);
    setName(mode === "rename" ? dir.slice(dir.lastIndexOf("/") + 1) : "");
    setError(null);
    setNotice(null);
  };

  const submitName = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = name.trim();
    if (naming === null || value === "" || value.includes("/") || value === "." || value === "..") {
      setError("Имя без «/», не «.» и не «..»");
      return;
    }
    setBusy(NAMING[naming].submit === "Создать" ? "Создаю…" : "Переименовываю…");
    setError(null);
    try {
      if (naming === "file") {
        const result = await rpc.call("ssh_put", { host, path: joinPath(dir, value), base64: "", overwrite: false });
        if (result.outcome === "exists") return setError(`«${value}» уже есть в этой папке`);
        onCreated(joinPath(dir, value));
      } else if (naming === "dir") {
        const result = await rpc.call("ssh_mkdir", { host, path: joinPath(dir, value) });
        if (result.outcome === "exists") return setError(`«${value}» уже есть в этой папке`);
        setNotice(`Создана папка ${value}`);
      } else {
        const to = joinPath(parentPath(dir), value);
        if (to === dir) return setNaming(null);
        const result = await rpc.call("ssh_rename", { host, from: dir, to });
        if (result.outcome === "exists") return setError(`«${value}» уже есть рядом`);
        if (result.outcome !== "renamed") return setError("Папки уже нет на сервере");
        onDirRenamed(to);
      }
      setNaming(null);
      setName("");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  const upload = async (file: File | undefined) => {
    if (picker.current !== null) picker.current.value = "";
    if (file === undefined) return;
    if (file.size > MAX_TRANSFER_BYTES) {
      setError(`Файл больше ${MAX_TRANSFER_BYTES / 1024 / 1024} МБ`);
      return;
    }
    try {
      const base64 = await fileToBase64(file);
      const result = await put(file.name, base64, false);
      if (result.outcome === "exists") setReplace({ name: file.name, base64 });
      else setNotice(`Загружено: ${file.name}`);
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  const openTerminal = async () => {
    setBusy("Открываю терминал…");
    setError(null);
    setNotice(null);
    try {
      await openSshTerminal(host, dir);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  const confirmReplace = async () => {
    if (replace === null) return;
    try {
      await put(replace.name, replace.base64, true);
      setNotice(`Заменено: ${replace.name}`);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setReplace(null);
    }
  };

  return (
    <div className="flex flex-col gap-1 rounded-md border border-border px-2 py-1.5">
      <div className="flex items-center gap-1">
        <Icon name="Folder" className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={dir}>
          {label}
        </span>
      </div>
      <div className="-ml-1 flex items-center gap-0.5">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          aria-label="SSH-сессия в этой папке"
          disabled={busy !== null}
          onClick={() => void openTerminal()}
        >
          <Icon name="Terminal" className="size-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          aria-label="Новый файл"
          disabled={busy !== null}
          onClick={() => toggleNaming("file")}
        >
          <Icon name="Plus" className="size-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          aria-label="Новая папка"
          disabled={busy !== null}
          onClick={() => toggleNaming("dir")}
        >
          <Icon name="FolderPlus" className="size-4" />
        </Button>
        {isRoot ? null : (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            aria-label="Переименовать папку"
            disabled={busy !== null}
            onClick={() => toggleNaming("rename")}
          >
            <Icon name="Edit" className="size-4" />
          </Button>
        )}
        {isRoot ? null : (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            aria-label="Удалить папку"
            disabled={busy !== null}
            onClick={() => void askRemoveDir()}
          >
            <Icon name="Trash2" className="size-4" />
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          aria-label="Загрузить файл"
          disabled={busy !== null}
          onClick={() => picker.current?.click()}
        >
          <Icon name="Download" className="size-4 rotate-180" />
        </Button>
        <input
          ref={picker}
          type="file"
          className="hidden"
          aria-hidden="true"
          tabIndex={-1}
          onChange={(event) => void upload(event.target.files?.[0])}
        />
      </div>
      {naming !== null ? (
        <form onSubmit={submitName} className="flex items-center gap-1">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => event.key === "Escape" && setNaming(null)}
            placeholder={NAMING[naming].placeholder}
            aria-label={NAMING[naming].label}
            autoFocus
            className="h-7 font-mono text-xs"
          />
          <Button type="submit" size="sm" className="h-7" disabled={busy !== null || name.trim() === ""}>
            {NAMING[naming].submit}
          </Button>
        </form>
      ) : null}
      {confirmRm !== null ? (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-destructive">
            {confirmRm.entries === 0
              ? `Удалить пустую папку «${dirName}»?`
              : `Удалить «${dirName}» и ${confirmRm.capped ? "больше " : ""}${confirmRm.entries} ${pluralEntries(confirmRm.entries)} внутри? Отменить нельзя.`}
          </span>
          <div className="flex items-center gap-1">
            <Button size="sm" variant="destructive" className="h-7" onClick={() => void removeDir()} disabled={busy !== null}>
              <Icon name="Trash2" className="size-4" />
              Точно удалить
            </Button>
            <Button size="sm" variant="ghost" className="h-7" onClick={() => setConfirmRm(null)} disabled={busy !== null}>
              Отмена
            </Button>
          </div>
        </div>
      ) : null}
      {replace !== null ? (
        <div className="flex items-center gap-1">
          <span className="min-w-0 flex-1 truncate text-xs text-destructive">
            «{replace.name}» уже есть. Заменить?
          </span>
          <Button size="sm" variant="destructive" className="h-7" onClick={() => void confirmReplace()} disabled={busy !== null}>
            Заменить
          </Button>
          <Button size="sm" variant="ghost" className="h-7" onClick={() => setReplace(null)} disabled={busy !== null}>
            Отмена
          </Button>
        </div>
      ) : null}
      {busy !== null ? <Muted>{busy}</Muted> : null}
      {notice !== null ? <Muted>{notice}</Muted> : null}
      {error !== null ? <ErrorLine>{error}</ErrorLine> : null}
    </div>
  );
}

function SshSidebar({ subPath }: PluginNavPanelProps) {
  const route = parseSubPath(subPath);
  const navigate = useBbNavigate();
  const [pickedHost, setPickedHost] = useState(() => localStorage.getItem(HOST_KEY));
  const host = route.host ?? pickedHost;
  return (
    <TreePanel
      host={host}
      activeFile={route.file}
      onPickHost={(next) => {
        localStorage.setItem(HOST_KEY, next);
        setPickedHost(next);
        navigate.toPluginPanel(PANEL_PATH, { subPath: next });
      }}
      onOpenFile={(path) => {
        if (host !== null) navigate.toPluginPanel(PANEL_PATH, { subPath: `${host}${path}` });
      }}
    />
  );
}

function TreePanel({
  host,
  activeFile,
  onPickHost,
  onOpenFile,
  fixedRoot,
}: {
  host: string | null;
  activeFile: string | null;
  onPickHost: (host: string) => void;
  onOpenFile: (path: string) => void;
  fixedRoot?: string;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const threadId = useContext(ThreadIdContext);
  const [hosts, setHosts] = useState<string[] | null>(null);
  const [roots, setRoots] = useState<Record<string, string> | null>(null);
  const [links, setLinks] = useState<Record<string, Link>>({});
  const [error, setError] = useState<string | null>(null);
  const [ownRoot, setOwnRoot] = useState<string | null>(fixedRoot ?? null);
  const sftpRoot = host?.startsWith("sftp:") ? links[host]?.remote : undefined;
  const root = host === null || roots === null ? null : (ownRoot ?? roots[host] ?? sftpRoot ?? "");
  const [resolvedRoot, setResolvedRoot] = useState<string | null>(null);
  const [rootInput, setRootInput] = useState("");
  const [generation, setGeneration] = useState(0);
  const [selectedDir, setSelectedDir] = useState<string | null>(null);
  const currentDir = selectedDir ?? resolvedRoot;

  useEffect(() => {
    rpc.call("ssh_hosts", threadId === null ? null : { threadId }).then(
      (result) => {
        setHosts(result.hosts);
        setRoots(result.roots);
        setLinks(result.links);
      },
      (cause) => setError(errorText(cause)),
    );
  }, [rpc, threadId]);

  useEffect(() => {
    setResolvedRoot(null);
    setSelectedDir(null);
  }, [host, root, generation]);

  useEffect(() => {
    if (root !== null) setRootInput(root);
  }, [root]);

  const changeRoot = useCallback(
    (next: string) => {
      if (host === null) return;
      setResolvedRoot(null);
      if (fixedRoot !== undefined) return setOwnRoot(next);
      setRoots((current) => ({ ...current, [host]: next }));
      rpc.call("ssh_set_root", { host, path: next }).catch((cause) => setError(errorText(cause)));
    },
    [host, rpc, fixedRoot],
  );

  const onResolved = useCallback((path: string) => {
    setResolvedRoot(path);
    setRootInput(path);
  }, []);

  const pickHost = (next: string) => {
    setOwnRoot(null);
    onPickHost(next);
  };

  const submitRoot = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = rootInput.trim();
    if (next === "" || next.startsWith("/")) changeRoot(next);
  };

  const openFile = onOpenFile;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-2">
      {error !== null ? <ErrorLine>{error}</ErrorLine> : null}
      {hosts !== null && hosts.length === 0 ? (
        <Muted>В ~/.ssh/config нет ни одного Host.</Muted>
      ) : null}
      <Select value={host ?? ""} onValueChange={pickHost} disabled={hosts === null}>
        <SelectTrigger aria-label="Сервер" className="h-8">
          <SelectValue placeholder={hosts === null ? "Загрузка…" : "Выберите сервер"} />
        </SelectTrigger>
        <SelectContent>
          {(hosts ?? []).map((name) => (
            <SelectItem key={name} value={name}>
              {name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {host !== null && root !== null ? (
        <>
          <form onSubmit={submitRoot} className="flex items-center gap-1">
            <Input
              value={rootInput}
              onChange={(event) => setRootInput(event.target.value)}
              placeholder="/var/www"
              aria-label="Папка"
              className="h-8 font-mono text-xs"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              aria-label="На уровень вверх"
              disabled={resolvedRoot === null || resolvedRoot === "/"}
              onClick={() => resolvedRoot !== null && changeRoot(parentPath(resolvedRoot))}
            >
              <Icon name="ArrowUp" className="size-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              aria-label="Обновить"
              onClick={() => setGeneration(generation + 1)}
            >
              <Icon name="RotateCcw" className="size-4" />
            </Button>
          </form>
          <LinkBar
            key={host}
            host={host}
            link={links[host]}
            defaultRemote={resolvedRoot}
            onChange={setLinks}
          />
          {currentDir !== null ? (
            <DirActions
              key={`${host}:${currentDir}`}
              host={host}
              dir={currentDir}
              root={resolvedRoot}
              onCreated={openFile}
              onDirRenamed={setSelectedDir}
              onDirDeleted={(parent) => setSelectedDir(parent === resolvedRoot ? null : parent)}
            />
          ) : null}
          <div className="min-h-0 flex-1 overflow-y-auto">
            <DirListing
              key={`${host}:${root}:${generation}`}
              host={host}
              path={root}
              depth={0}
              activeFile={activeFile}
              selectedDir={selectedDir}
              onOpen={openFile}
              onSelectDir={setSelectedDir}
              onResolved={onResolved}
            />
          </div>
        </>
      ) : null}
    </div>
  );
}

function Placeholder({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div
        role="status"
        className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground"
      >
        {children}
      </div>
    </div>
  );
}

type LocalStatus =
  | { linked: false }
  | { linked: true; localPath: string; exists: boolean; sha256: string | null; content: string | null };

function useLocalCopy(host: string, file: string) {
  const rpc = useRpc<typeof rpcContract>();
  const [local, setLocal] = useState<LocalStatus | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const reloadLocal = useCallback(() => {
    rpc.call("ssh_local_status", { host, path: file }).then(
      (result) => {
        setLocal(result);
        setLocalError(null);
      },
      (cause) => setLocalError(errorText(cause)),
    );
  }, [rpc, host, file]);
  useEffect(reloadLocal, [reloadLocal]);
  useRealtime(LINKS_CHANGED, reloadLocal);
  return { local, localError, reloadLocal };
}

function LocalBar({
  host,
  file,
  doc,
  local,
  localError,
  disabled,
  compare,
  onCompare,
  onReloadLocal,
  onServerWritten,
}: {
  host: string;
  file: string;
  doc: FileDoc;
  local: Extract<LocalStatus, { linked: true }>;
  localError: string | null;
  disabled: boolean;
  compare: boolean;
  onCompare: (value: boolean) => void;
  onReloadLocal: () => void;
  onServerWritten: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [confirm, setConfirm] = useState<"pull" | "push" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const differs = local.exists && local.sha256 !== doc.sha256;
  const canCompare = differs && doc.kind === "text" && local.content !== null;

  const pull = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await rpc.call("ssh_pull", {
        host,
        path: file,
        expectedLocalSha256: local.exists ? local.sha256 : null,
      });
      if (result.outcome === "conflict") setError("Локальный файл изменился, пока вы смотрели. Проверьте ещё раз.");
      onCompare(false);
      onReloadLocal();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  const push = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await rpc.call("ssh_push", { host, path: file, expectedSha256: doc.sha256 });
      if (result.outcome === "conflict") {
        setError("Файл на сервере изменился после открытия. Нажмите «Обновить» и сравните снова.");
      } else {
        onCompare(false);
        onServerWritten();
      }
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  const state = !local.exists ? "нет в проекте" : differs ? "отличается" : "совпадает";

  return (
    <div className="flex flex-col gap-1 border-b border-border px-4 py-1.5">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={local.localPath}>
          Локально: {shortHome(local.localPath)} ·{" "}
          <span className={cn(differs && "text-foreground")}>{state}</span>
        </span>
        {confirm !== null ? (
          <>
            <span className="text-xs text-destructive">
              {confirm === "pull" ? "Заменить локальный файл серверной версией?" : "Заменить файл на сервере локальной версией?"}
            </span>
            <Button
              size="sm"
              variant="destructive"
              className="h-7"
              disabled={busy}
              onClick={() => void (confirm === "pull" ? pull() : push())}
            >
              Заменить
            </Button>
            <Button size="sm" variant="ghost" className="h-7" disabled={busy} onClick={() => setConfirm(null)}>
              Отмена
            </Button>
          </>
        ) : (
          <>
            {canCompare ? (
              <Button
                size="sm"
                variant="ghost"
                className="h-7"
                aria-pressed={compare}
                disabled={disabled}
                onClick={() => onCompare(!compare)}
              >
                Сравнить
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              className="h-7"
              disabled={disabled || busy || (local.exists && !differs)}
              onClick={() => (local.exists ? setConfirm("pull") : void pull())}
            >
              <Icon name="Download" className="size-4" />В проект
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7"
              disabled={disabled || busy || !differs}
              onClick={() => setConfirm("push")}
            >
              <Icon name="Download" className="size-4 rotate-180" />На сервер
            </Button>
          </>
        )}
      </div>
      {error !== null || localError !== null ? <ErrorLine>{error ?? localError}</ErrorLine> : null}
    </div>
  );
}

function FileView({
  host,
  file,
  onNavigate,
  onBack,
}: {
  host: string;
  file: string;
  onNavigate: (file: string | null) => void;
  onBack?: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [doc, setDoc] = useState<FileDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [renameTo, setRenameTo] = useState<string | null>(null);
  const openSshTerminal = useOpenSshTerminal();
  const [seed, setSeed] = useState("");
  const [merge, setMerge] = useState<{ conflicts: number; mine: string } | null>(null);

  const startEditing = (content: string) => {
    setSeed(content);
    setDraft(content);
  };

  const stopEditing = () => {
    setDraft(null);
    setMerge(null);
  };

  const { local, localError, reloadLocal } = useLocalCopy(host, file);
  const [compare, setCompare] = useState(false);

  const load = useCallback(() => {
    setError(null);
    setNotice(null);
    setConfirmDelete(false);
    setMerge(null);
    rpc.call("ssh_read", { host, path: file }).then(
      (result) => {
        setDoc(result);
        setDraft(null);
        reloadLocal();
      },
      (cause) => setError(errorText(cause)),
    );
  }, [rpc, host, file, reloadLocal]);

  useEffect(load, [load]);

  const save = async () => {
    if (doc?.kind !== "text" || draft === null || saving) return;
    if (hasConflictMarkers(draft)) {
      setError("В тексте остались отметки конфликта «<<<<<<< ваши правки» / «>>>>>>> сервер». Уберите их и сохраните.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await rpc.call("ssh_write", {
        host,
        path: file,
        content: draft,
        expectedSha256: doc.sha256,
      });
      if (result.outcome === "written") {
        setDoc({ kind: "text", content: draft, sha256: result.sha256, size: draft.length });
        stopEditing();
        setNotice("Сохранено");
        reloadLocal();
      } else if (result.currentSha256 === null) {
        setError("Файл удалён на сервере. Правки не сохранены, скопируйте их из редактора.");
      } else {
        const theirs = await rpc.call("ssh_read", { host, path: file });
        if (theirs.kind !== "text") {
          setError("На сервере файл заменили бинарным. Правки не сохранены.");
          return;
        }
        const merged = mergeThreeWay(doc.content, draft, theirs.content);
        setDoc(theirs);
        startEditing(merged.text);
        setMerge({ conflicts: merged.conflicts, mine: draft });
      }
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSaving(false);
    }
  };

  const download = async () => {
    setSaving(true);
    setError(null);
    setNotice("Скачиваю…");
    try {
      const { base64 } = await rpc.call("ssh_download", { host, path: file });
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const outcome = await experimental_saveFile({
        fileName: file.slice(file.lastIndexOf("/") + 1),
        blob: new Blob([bytes]),
      });
      setNotice(outcome === "started" ? null : "Не удалось начать скачивание");
    } catch (cause) {
      setNotice(null);
      setError(errorText(cause));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (doc === null || saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await rpc.call("ssh_delete", { host, path: file, expectedSha256: doc.sha256 });
      if (result.outcome === "deleted") {
        onNavigate(null);
        return;
      }
      setConfirmDelete(false);
      setError(
        result.currentSha256 === null
          ? "Файла уже нет на сервере."
          : "Файл изменился на сервере после открытия. Нажмите «Обновить» и повторите.",
      );
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSaving(false);
    }
  };

  const openTerminalHere = async () => {
    setError(null);
    try {
      await openSshTerminal(host, parentPath(file));
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  const rename = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = (renameTo ?? "").trim();
    const to = value.endsWith("/") ? `${value}${file.slice(file.lastIndexOf("/") + 1)}` : value;
    const segments = to.split("/").slice(1);
    if (!to.startsWith("/") || segments.some((s) => s === "" || s === "." || s === "..")) {
      setError("Нужен полный путь вида /папка/имя-файла, без «.» и «..». Путь с «/» на конце – перенос с тем же именем.");
      return;
    }
    if (to === file) return setRenameTo(null);
    setSaving(true);
    setError(null);
    try {
      const result = await rpc.call("ssh_rename", { host, from: file, to });
      if (result.outcome === "renamed") {
        onNavigate(to);
        return;
      }
      setError(
        result.outcome === "exists"
          ? `«${to}» уже существует`
          : result.outcome === "nodir"
            ? `Папки «${parentPath(to)}» нет на сервере`
            : "Файла уже нет на сервере.",
      );
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSaving(false);
    }
  };

  const editing = draft !== null;
  const dirty = editing && doc?.kind === "text" && draft !== doc.content;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        {onBack !== undefined ? (
          <Button size="sm" variant="ghost" className="-ml-2 px-2" aria-label="Назад к дереву" onClick={onBack}>
            <Icon name="ChevronLeft" className="size-4" />
          </Button>
        ) : (
          <Icon name="Terminal" className="size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={`${host}:${file}`}>
          {host}:{file}
          {dirty ? " •" : ""}
        </span>
        {notice !== null ? <span className="text-xs text-muted-foreground">{notice}</span> : null}
        {editing ? (
          <>
            <Button size="sm" onClick={() => void save()} disabled={!dirty || saving}>
              <Icon name="Check" className="size-4" />
              {saving ? "Сохраняю…" : "Сохранить"}
            </Button>
            <Button size="sm" variant="ghost" onClick={stopEditing} disabled={saving}>
              Отмена
            </Button>
          </>
        ) : renameTo !== null ? (
          <form onSubmit={rename} className="flex min-w-0 flex-1 items-center gap-1">
            <Input
              value={renameTo}
              onChange={(event) => setRenameTo(event.target.value)}
              onKeyDown={(event) => event.key === "Escape" && setRenameTo(null)}
              aria-label="Новый путь файла"
              autoFocus
              className="h-8 min-w-0 flex-1 font-mono text-xs"
            />
            <Button type="submit" size="sm" disabled={saving || renameTo.trim() === ""}>
              {saving
                ? "Применяю…"
                : parentPath(renameTo.trim().endsWith("/") ? `${renameTo.trim()}x` : renameTo.trim()) === parentPath(file)
                  ? "Переименовать"
                  : "Переместить"}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setRenameTo(null)} disabled={saving}>
              Отмена
            </Button>
          </form>
        ) : confirmDelete ? (
          <>
            <span className="text-xs text-destructive">Удалить файл на сервере?</span>
            <Button size="sm" variant="destructive" onClick={() => void remove()} disabled={saving}>
              <Icon name="Trash2" className="size-4" />
              {saving ? "Удаляю…" : "Точно удалить"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)} disabled={saving}>
              Отмена
            </Button>
          </>
        ) : (
          <>
            <Button
              size="sm"
              variant="ghost"
              aria-label="SSH-сессия в папке файла"
              onClick={() => void openTerminalHere()}
            >
              <Icon name="Terminal" className="size-4" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label="Переименовать или переместить файл"
              disabled={saving}
              onClick={() => {
                setNotice(null);
                setRenameTo(file);
              }}
            >
              <Icon name="Edit" className="size-4" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label="Скачать файл"
              disabled={doc === null || saving}
              onClick={() => void download()}
            >
              <Icon name="Download" className="size-4" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label="Удалить файл"
              disabled={doc === null}
              onClick={() => {
                setNotice(null);
                setConfirmDelete(true);
              }}
            >
              <Icon name="Trash2" className="size-4" />
            </Button>
            <Button size="sm" variant="ghost" aria-label="Обновить" onClick={load}>
              <Icon name="RotateCcw" className="size-4" />
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={doc?.kind !== "text"}
              onClick={() => {
                if (doc?.kind !== "text") return;
                setNotice(null);
                startEditing(doc.content);
              }}
            >
              <Icon name="Edit" className="size-4" />
              Править
            </Button>
          </>
        )}
      </div>
      {error !== null ? (
        <div className="border-b border-border px-4 py-2">
          <ErrorLine>{error}</ErrorLine>
        </div>
      ) : null}
      {doc !== null && local?.linked ? (
        <LocalBar
          host={host}
          file={file}
          doc={doc}
          local={local}
          localError={localError}
          disabled={editing}
          compare={compare && !editing}
          onCompare={setCompare}
          onReloadLocal={reloadLocal}
          onServerWritten={load}
        />
      ) : null}
      {editing && merge !== null ? (
        <div className="flex items-center gap-2 border-b border-border bg-state-hover px-4 py-2">
          <Icon
            name={merge.conflicts === 0 ? "Check" : "AlertTriangle"}
            className={cn("size-4 shrink-0", merge.conflicts > 0 && "text-destructive")}
          />
          <span className="min-w-0 flex-1 text-xs">
            {merge.conflicts === 0
              ? "Файл на сервере изменился, пока вы правили. Изменения объединены автоматически – проверьте и сохраните."
              : `Файл на сервере изменился. Конфликтов: ${merge.conflicts} – они между «<<<<<<< ваши правки» и «>>>>>>> сервер». Оставьте нужное и сохраните.`}
          </span>
          {merge.conflicts > 0 ? (
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              onClick={() => {
                startEditing(merge.mine);
                setMerge(null);
              }}
            >
              Оставить мою версию
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" className="h-7" onClick={stopEditing}>
            Взять с сервера
          </Button>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto">
        {doc === null ? (
          error === null ? <Placeholder>Загрузка…</Placeholder> : null
        ) : doc.kind === "binary" ? (
          <Placeholder>Бинарный файл, {doc.size} байт — не показываю.</Placeholder>
        ) : editing ? (
          <CodeEditor
            path={file}
            initialValue={seed}
            onChange={setDraft}
            onSave={() => void save()}
          />
        ) : compare && local?.linked && local.content !== null ? (
          <Diff
            patch={createTwoFilesPatch(file, file, doc.content, local.content, "сервер", "локально")}
            path={file}
          />
        ) : (
          <SourceCode content={doc.content} path={file} />
        )}
      </div>
    </div>
  );
}

function SshPage({ subPath }: PluginNavPanelProps) {
  const { host, file } = parseSubPath(subPath);
  const navigate = useBbNavigate();
  useEffect(() => {
    pageTerminalOpener = navigate.experimental_openTerminal;
    return () => {
      pageTerminalOpener = null;
    };
  }, [navigate]);
  if (host === null || file === null) {
    return <Placeholder>Выберите сервер и файл слева.</Placeholder>;
  }
  return (
    <FileView
      key={`${host}:${file}`}
      host={host}
      file={file}
      onNavigate={(next) =>
        navigate.toPluginPanel(PANEL_PATH, { subPath: next === null ? host : `${host}${next}`, replace: true })
      }
    />
  );
}

function ThreadSshTab({ threadId }: ExperimentalThreadActionTabProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [ready, setReady] = useState(false);
  const [host, setHost] = useState<string | null>(null);
  const [fixedRoot, setFixedRoot] = useState<string | undefined>(undefined);
  const [file, setFile] = useState<string | null>(null);

  useEffect(() => {
    rpc
      .call("ssh_thread_target", { threadId })
      .then(
        (target) => {
          if (target === null) return setHost(localStorage.getItem(HOST_KEY));
          setHost(target.host);
          setFixedRoot(target.dir);
        },
        () => setHost(localStorage.getItem(HOST_KEY)),
      )
      .finally(() => setReady(true));
  }, [rpc, threadId]);

  if (!ready) return <Placeholder>Загрузка…</Placeholder>;

  return (
    <ThreadIdContext.Provider value={threadId}>
      <div className="flex h-full min-h-0 flex-col">
        <div className={cn("min-h-0 flex-1", file !== null && "hidden")}>
          <TreePanel
            host={host}
            activeFile={file}
            fixedRoot={fixedRoot}
            onPickHost={(next) => {
              localStorage.setItem(HOST_KEY, next);
              setHost(next);
              setFile(null);
            }}
            onOpenFile={setFile}
          />
        </div>
        {file !== null && host !== null ? (
          <FileView key={`${host}:${file}`} host={host} file={file} onNavigate={setFile} onBack={() => setFile(null)} />
        ) : null}
      </div>
    </ThreadIdContext.Provider>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_tab({
    context: { kind: "thread" },
    availability: "action",
    id: "ssh",
    title: "SSH",
    icon: "Terminal",
    component: ThreadSshTab,
    layout: "flush",
  });
  app.slots.navPanel({
    id: "ssh",
    title: "SSH",
    icon: "Terminal",
    path: PANEL_PATH,
    component: SshPage,
    experimental_sidebar: SshSidebar,
  });
});
