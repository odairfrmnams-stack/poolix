import "server-only";

import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join, relative, resolve, isAbsolute } from "node:path";

import { assertKey, datasetKey } from "@/services/storage/keys";
import { workerLog } from "@/services/storage/log";
import { interpret, stamp, type LoadResult, type VersionedSpec } from "@/services/storage/versioned";

/*
  The persistence boundary for analytics state.

  Analytics modules used to each open their own file, parse their own JSON and decide for
  themselves what a corrupt cache meant. That is eight copies of a decision that has to be
  identical, and it is also what makes the storage medium impossible to change: every
  module hard-codes a path.

  This puts one interface in front of it. The filesystem implementation below writes
  exactly the files those modules already wrote, in the same place and the same format, so
  adopting it invalidates nothing — an important property when a rebuild costs hours.

  WHAT THIS IS NOT. A filesystem is not distributed storage. Two instances writing the same
  key here will not corrupt a file — the write is atomic — but the later write wins
  regardless of which state is newer, and neither instance can detect that it happened.
  The interface is shaped for a backend that CAN detect it (see `setIfUnchanged`), and the
  filesystem implementation says honestly that it cannot.
*/

export interface Storage {
  /** Raw stored value, or null when absent or unreadable. */
  get(key: string): Promise<unknown | null>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** Keys beginning with `prefix`, in no guaranteed order. */
  list(prefix: string): Promise<string[]>;
  /**
   * Writes only if the stored value still carries `expectedRevision`.
   *
   * Returns false when the value moved underneath the caller. A backend without
   * compare-and-swap reports `supportsCompareAndSwap: false` and always writes, which is
   * why callers must treat a true result as "written", not as "no one else wrote".
   */
  setIfUnchanged(key: string, value: unknown, expectedRevision: string | null): Promise<boolean>;
  /** An opaque token identifying the current stored value, or null when absent. */
  revision(key: string): Promise<string | null>;
  readonly supportsCompareAndSwap: boolean;
  readonly description: string;
}

const EXTENSION = ".json";

/**
 * Filesystem storage: one JSON file per key, written atomically.
 *
 * Atomicity comes from writing a uniquely named temporary file and renaming it over the
 * target. A rename within a filesystem is atomic, so a reader sees either the whole old
 * file or the whole new one — never a half-written one. The temporary name carries the
 * process id so two writers cannot collide on the scratch file itself.
 */
export class FilesystemStorage implements Storage {
  readonly supportsCompareAndSwap = false;
  readonly description: string;

  constructor(private readonly directory: string) {
    this.description = `filesystem:${directory}`;
  }

  /**
   * The file backing a key, proven to sit inside the cache directory.
   *
   * `assertKey` already makes traversal impossible — the allowlist admits no separator, no
   * `..` and no null byte — so the containment check below can never fire today. It is here
   * because the two defences fail differently: the allowlist is a statement about the
   * characters in a key, and this is a statement about where the path actually lands. If
   * the allowlist is ever loosened for a plausible-looking reason, this still holds.
   */
  private path(key: string): string {
    const target = resolve(join(this.directory, `${assertKey(key)}${EXTENSION}`));
    const root = resolve(this.directory);
    const inside = relative(root, target);
    if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
      throw new Error("Refusing a storage path outside the cache directory");
    }
    return target;
  }

  async get(key: string): Promise<unknown | null> {
    try {
      return JSON.parse(await readFile(this.path(key), "utf8")) as unknown;
    } catch {
      // Absent and unparseable are both "nothing usable here". The caller distinguishes
      // them through `interpret`, which sees the raw value.
      return null;
    }
  }

  async set(key: string, value: unknown): Promise<void> {
    const target = this.path(key);
    try {
      await mkdir(this.directory, { recursive: true });
      const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, JSON.stringify(value), "utf8");
      await rename(temporary, target);
    } catch (error) {
      /*
        A read-only filesystem costs the cache, not correctness: the next process rebuilds.
        Throwing here would take down a page render over a disposable file.

        But silence was wrong. A deployment whose volume is not writable rebuilds every
        dataset on every tick, for ever, and every symptom of that appears somewhere else —
        the site is slow, the endpoint is throttled, nothing is ever complete. The one fact
        that explains it all is this failure, so it is logged. The message is redacted like
        any other, and it names the dataset rather than the path.
      */
      workerLog.warn({
        dataset: key,
        reason: "persist",
        published: false,
        withheldBecause: "the state file could not be written",
        // The errno code (EACCES, EROFS, ENOSPC) is the whole diagnosis. The message that
        // carries it also carries the absolute path, which is not something to print.
        error: (error as NodeJS.ErrnoException).code ?? "unknown",
      });
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.path(key));
    } catch {
      // Already gone is the desired state.
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await readFile(this.path(key), "utf8");
      return true;
    } catch {
      return false;
    }
  }

  async list(prefix: string): Promise<string[]> {
    try {
      const entries = await readdir(this.directory);
      return entries
        .filter((entry) => entry.endsWith(EXTENSION))
        .map((entry) => entry.slice(0, -EXTENSION.length))
        .filter((key) => key.startsWith(prefix));
    } catch {
      return [];
    }
  }

  /** Size and mtime together: enough to notice a change, cheap to obtain. */
  async revision(key: string): Promise<string | null> {
    try {
      const { stat } = await import("node:fs/promises");
      const info = await stat(this.path(key));
      return `${info.size}:${info.mtimeMs}`;
    } catch {
      return null;
    }
  }

  /**
   * Always writes, and says so by reporting `supportsCompareAndSwap: false`.
   *
   * The revision is re-read and compared first, which closes the window for a slow writer
   * but not for a concurrent one — between the check and the rename another process can
   * still land. Pretending otherwise would be worse than the gap itself, so callers that
   * need real exclusion take a lease instead.
   */
  async setIfUnchanged(key: string, value: unknown, expectedRevision: string | null): Promise<boolean> {
    const current = await this.revision(key);
    if (current !== expectedRevision) return false;
    await this.set(key, value);
    return true;
  }
}

// ---------------------------------------------------------------- typed access

export interface DatasetStore<T> {
  load(): Promise<LoadResult<T>>;
  save(value: T): Promise<void>;
  revision(): Promise<string | null>;
  /** Writes only if unchanged since `expectedRevision`. False when it moved. */
  saveIfUnchanged(value: T, expectedRevision: string | null): Promise<boolean>;
  readonly key: string;
}

/**
 * A typed view of one dataset: reads are interpreted against its schema and writes are
 * stamped with it, so state can never be stored without the fields that let the next
 * reader judge whether it is safe to use.
 */
export function datasetStore<T extends object>(
  storage: Storage,
  key: string,
  spec: VersionedSpec<T>,
): DatasetStore<T> {
  return {
    key,
    async load() {
      return interpret(await storage.get(key), spec);
    },
    async save(value) {
      await storage.set(key, stamp(value, spec));
    },
    revision() {
      return storage.revision(key);
    },
    saveIfUnchanged(value, expectedRevision) {
      return storage.setIfUnchanged(key, stamp(value, spec), expectedRevision);
    },
  };
}

/**
 * A typed store for one analytics dataset, keyed and versioned by convention.
 *
 * The single entry point the analytics modules use, so all eight share one decision about
 * what an unreadable cache means instead of eight copies of it.
 */
export function analyticsStore<T extends object>(
  dataset: string,
  version: number,
  chainId: number,
  validate: (value: unknown) => value is T,
  migrate?: (value: unknown, fromVersion: number) => T | null,
): DatasetStore<T> {
  return datasetStore(storage(), datasetKey(dataset, chainId), {
    dataset,
    version,
    chainId,
    validate,
    migrate,
  });
}

let defaultStorage: Storage | null = null;

/** The process-wide storage backend. Filesystem today; the interface allows others. */
export function storage(): Storage {
  defaultStorage ??= new FilesystemStorage(join(process.cwd(), ".poolix-cache"));
  return defaultStorage;
}

/** Test seam. Replaces the backend for the current process. */
export function setStorage(next: Storage | null): void {
  defaultStorage = next;
}
