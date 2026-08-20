import { BadRequestException, ConflictException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import {
  ManagedMeilisearchSettingsSchema,
  ManagedMeilisearchSettingsShapeSchema,
  defaultManagedMeilisearchSettings,
  requiredMeilisearchAttributes,
  type IndexScope,
  type ManagedMeilisearchSettings,
  type MeilisearchEmbedderSummary,
  type MeilisearchIndexSettingsStatus,
  type MeilisearchSettingsStatus,
  type MeilisearchTaskState,
} from "@samplehub/contracts";
import { getConfig } from "../common/config";
import { StateService } from "../state/state.service";

const PROFILE_KEY = "meilisearch_settings_profile_v2";
const APPLICATION_KEY = "meilisearch_settings_application_v2";

interface ApplicationEntry {
  scope: IndexScope;
  uid: string;
  taskUid: number | null;
  submissionError: string | null;
}

interface SettingsApplication {
  submittedAt: string;
  entries: ApplicationEntry[];
}

interface MeilisearchTask {
  status?: MeilisearchTaskState;
  error?: { message?: string; code?: string } | null;
}

@Injectable()
export class MeilisearchSettingsService {
  private readonly config = getConfig();

  constructor(private readonly state: StateService) {}

  getProfile(): ManagedMeilisearchSettings {
    const stored = this.state.getSetting<unknown>(PROFILE_KEY);
    const parsed = ManagedMeilisearchSettingsSchema.safeParse(stored);
    return parsed.success ? parsed.data : structuredClone(defaultManagedMeilisearchSettings);
  }

  async status(): Promise<MeilisearchSettingsStatus> {
    const profile = this.getProfile();
    const application = this.state.getSetting<SettingsApplication>(APPLICATION_KEY);
    const scopes = this.managedIndexes();
    const [version, ...indexes] = await Promise.all([
      this.version(),
      ...scopes.map((entry) => this.indexStatus(entry.scope, entry.uid, profile, application)),
    ]);
    return {
      profile,
      defaults: structuredClone(defaultManagedMeilisearchSettings),
      required: requiredMeilisearchAttributes,
      indexes,
      applying: indexes.some((index) => index.taskStatus === "enqueued" || index.taskStatus === "processing"),
      indexingBusy: this.state.hasActiveIndexRuns(),
      environment: { url: this.config.MEILI_URL, baseIndexUid: this.config.MEILI_INDEX_UID, version },
    };
  }

  async apply(input: unknown): Promise<MeilisearchSettingsStatus> {
    if (this.state.hasActiveIndexRuns()) throw new ConflictException("Wait for active index builds or backfills to finish before changing Meilisearch settings");
    await this.assertNoSettingsApplication();
    const parsed = ManagedMeilisearchSettingsSchema.safeParse(input);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
    }
    const profile = parsed.data;
    this.state.setSetting(PROFILE_KEY, profile);
    const available = await Promise.all(this.managedIndexes().map(async (entry) => ({ ...entry, available: await this.indexExists(entry.uid) })));
    const entries = await Promise.all(available.filter((entry) => entry.available).map(async ({ scope, uid }): Promise<ApplicationEntry> => {
      try {
        const response = await this.request<{ taskUid: number }>("PATCH", `/indexes/${encodeURIComponent(uid)}/settings`, profile);
        return { scope, uid, taskUid: response.taskUid, submissionError: null };
      } catch (error) {
        return { scope, uid, taskUid: null, submissionError: error instanceof Error ? error.message : "Unable to submit settings" };
      }
    }));
    this.state.setSetting(APPLICATION_KEY, { submittedAt: new Date().toISOString(), entries } satisfies SettingsApplication);
    return this.status();
  }

  async reset(): Promise<MeilisearchSettingsStatus> {
    return this.apply(structuredClone(defaultManagedMeilisearchSettings));
  }

  async retry(): Promise<MeilisearchSettingsStatus> {
    return this.apply(this.getProfile());
  }

  async assertIndexOperationsAllowed(): Promise<void> {
    await this.assertNoSettingsApplication();
  }

  private async assertNoSettingsApplication(): Promise<void> {
    const application = this.state.getSetting<SettingsApplication>(APPLICATION_KEY);
    if (!application) return;
    const tasks = await Promise.all(application.entries.flatMap((entry) => entry.taskUid === null ? [] : [this.task(entry.taskUid)]));
    if (tasks.some((task) => task.status === "enqueued" || task.status === "processing")) {
      throw new ConflictException("Wait for the current Meilisearch settings application to finish before starting another index operation");
    }
  }

  private managedIndexes(): Array<{ scope: IndexScope; uid: string }> {
    return [
      { scope: "stable", uid: this.config.MEILI_INDEX_UID },
      { scope: "preview_legacy", uid: `${this.config.MEILI_INDEX_UID}_preview_legacy` },
      { scope: "preview_current", uid: `${this.config.MEILI_INDEX_UID}_preview_current` },
    ];
  }

  private async indexStatus(scope: IndexScope, uid: string, profile: ManagedMeilisearchSettings, application: SettingsApplication | null): Promise<MeilisearchIndexSettingsStatus> {
    const entry = application?.entries.find((candidate) => candidate.uid === uid);
    const [live, task] = await Promise.all([
      this.liveSettings(uid),
      entry?.taskUid === null || entry?.taskUid === undefined ? Promise.resolve(null) : this.task(entry.taskUid),
    ]);
    const taskError = task?.error?.message ?? task?.error?.code ?? null;
    return {
      scope,
      uid,
      available: live !== null,
      inSync: live !== null && this.equalSettings(live.settings, profile),
      settings: live?.settings ?? null,
      embedders: live?.embedders ?? [],
      taskUid: entry?.taskUid ?? null,
      taskStatus: task?.status ?? (entry?.submissionError ? "failed" : null),
      error: entry?.submissionError ?? taskError,
    };
  }

  private async liveSettings(uid: string): Promise<{ settings: ManagedMeilisearchSettings; embedders: MeilisearchEmbedderSummary[] } | null> {
    const response = await fetch(`${this.config.MEILI_URL}/indexes/${encodeURIComponent(uid)}/settings`, { headers: this.headers() });
    if (response.status === 404) return null;
    if (!response.ok) throw new ServiceUnavailableException(`Meilisearch settings read failed: ${(await response.text()).slice(0, 300)}`);
    const raw = await response.json() as Record<string, unknown>;
    const parsed = ManagedMeilisearchSettingsShapeSchema.safeParse({
      displayedAttributes: raw.displayedAttributes,
      searchableAttributes: raw.searchableAttributes,
      filterableAttributes: raw.filterableAttributes,
      sortableAttributes: raw.sortableAttributes,
      pagination: raw.pagination,
      faceting: raw.faceting,
    });
    if (!parsed.success) throw new ServiceUnavailableException(`The ${uid} index has settings that this admin version cannot manage: ${parsed.error.issues[0]?.message ?? "invalid settings"}`);
    const rawEmbedders = raw.embedders && typeof raw.embedders === "object" ? raw.embedders as Record<string, unknown> : {};
    const embedders = Object.entries(rawEmbedders).sort(([left], [right]) => left.localeCompare(right)).map(([name, value]) => {
      const definition = value && typeof value === "object" ? value as Record<string, unknown> : {};
      return { name, source: typeof definition.source === "string" ? definition.source : "unknown", dimensions: typeof definition.dimensions === "number" ? definition.dimensions : null };
    });
    return { settings: parsed.data, embedders };
  }

  private async indexExists(uid: string): Promise<boolean> {
    const response = await fetch(`${this.config.MEILI_URL}/indexes/${encodeURIComponent(uid)}`, { headers: this.headers() });
    if (response.status === 404) return false;
    if (!response.ok) throw new ServiceUnavailableException(`Meilisearch index check failed: ${(await response.text()).slice(0, 300)}`);
    return true;
  }

  private async version(): Promise<string | null> {
    try {
      const value = await this.request<{ pkgVersion?: string }>("GET", "/version");
      return value.pkgVersion ?? null;
    } catch {
      return null;
    }
  }

  private async task(taskUid: number): Promise<MeilisearchTask> {
    return this.request<MeilisearchTask>("GET", `/tasks/${taskUid}`);
  }

  private async request<T>(method: "GET" | "PATCH", path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.config.MEILI_URL}${path}`, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new ServiceUnavailableException(`Meilisearch ${method} ${path}: ${(await response.text()).slice(0, 300)}`);
    return response.json() as Promise<T>;
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.config.MEILI_MASTER_KEY}`, "Content-Type": "application/json" };
  }

  private equalSettings(left: ManagedMeilisearchSettings, right: ManagedMeilisearchSettings): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
  }
}
