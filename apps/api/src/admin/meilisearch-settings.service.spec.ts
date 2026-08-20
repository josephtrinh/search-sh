import { BadRequestException, ConflictException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { defaultManagedMeilisearchSettings } from "@samplehub/contracts";
import { StateService } from "../state/state.service";
import { MeilisearchSettingsService } from "./meilisearch-settings.service";

describe("MeilisearchSettingsService", () => {
  const originalFetch = globalThis.fetch;
  let service: MeilisearchSettingsService;
  let stored: Map<string, unknown>;
  let activeRuns: boolean;
  let fetchMock: jest.Mock;

  beforeEach(async () => {
    stored = new Map();
    activeRuns = false;
    const module = await Test.createTestingModule({
      providers: [
        MeilisearchSettingsService,
        {
          provide: StateService,
          useValue: {
            getSetting: jest.fn((key: string) => stored.get(key) ?? null),
            setSetting: jest.fn((key: string, value: unknown) => stored.set(key, value)),
            hasActiveIndexRuns: jest.fn(() => activeRuns),
          },
        },
      ],
    }).compile();
    service = module.get(MeilisearchSettingsService);
    fetchMock = jest.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/version") return Response.json({ pkgVersion: "1.45.1" });
      if (url.pathname === "/indexes/products/settings" && init?.method !== "PATCH") {
        return Response.json({ ...defaultManagedMeilisearchSettings, embedders: { e5_text: { source: "userProvided", dimensions: 768 } } });
      }
      if (url.pathname === "/indexes/products" && init?.method !== "PATCH") return Response.json({ uid: "products" });
      if (url.pathname.includes("_preview_")) return new Response("Not found", { status: 404 });
      if (url.pathname === "/indexes/products/settings" && init?.method === "PATCH") return Response.json({ taskUid: 7 }, { status: 202 });
      if (url.pathname === "/tasks/7") return Response.json({ status: "succeeded", error: null });
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url.pathname}`);
    });
    globalThis.fetch = fetchMock;
  });

  afterEach(() => { globalThis.fetch = originalFetch; jest.restoreAllMocks(); });

  it("returns defaults, live drift status, and read-only embedders", async () => {
    const result = await service.status();
    expect(result.profile).toEqual(defaultManagedMeilisearchSettings);
    expect(result.environment.version).toBe("1.45.1");
    expect(result.indexes[0]).toMatchObject({ scope: "stable", available: true, inSync: true });
    expect(result.indexes[0]?.embedders).toEqual([{ name: "e5_text", source: "userProvided", dimensions: 768 }]);
    expect(result.indexes[1]).toMatchObject({ available: false, inSync: false });
  });

  it("omits retired empty catalog fields from the managed defaults", () => {
    const retiredFields = ["category", "categoryZh", "detail", "price", "availability"];
    for (const attributes of [
      defaultManagedMeilisearchSettings.displayedAttributes,
      defaultManagedMeilisearchSettings.searchableAttributes,
      defaultManagedMeilisearchSettings.filterableAttributes,
      defaultManagedMeilisearchSettings.sortableAttributes,
    ]) {
      for (const field of retiredFields) expect(attributes).not.toContain(field);
    }
  });

  it("persists and submits a valid global profile", async () => {
    const profile = structuredClone(defaultManagedMeilisearchSettings);
    profile.pagination.maxTotalHits = 500;
    const result = await service.apply(profile);
    expect(stored.get("meilisearch_settings_profile_v2")).toEqual(profile);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/indexes/products/settings"), expect.objectContaining({ method: "PATCH" }));
    expect(result.indexes[0]).toMatchObject({ taskUid: 7, taskStatus: "succeeded" });
  });

  it("blocks removal of fields required by the application", async () => {
    const profile = structuredClone(defaultManagedMeilisearchSettings);
    profile.filterableAttributes = profile.filterableAttributes.filter((field) => field !== "groupId");
    await expect(service.apply(profile)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("blocks settings updates during index work", async () => {
    activeRuns = true;
    await expect(service.apply(defaultManagedMeilisearchSettings)).rejects.toBeInstanceOf(ConflictException);
  });

  it("blocks index work while a settings task is pending", async () => {
    stored.set("meilisearch_settings_application_v2", { submittedAt: new Date().toISOString(), entries: [{ scope: "stable", uid: "products", taskUid: 7, submissionError: null }] });
    fetchMock.mockImplementationOnce(async () => Response.json({ status: "processing", error: null }));
    await expect(service.assertIndexOperationsAllowed()).rejects.toBeInstanceOf(ConflictException);
  });

  it("reset and retry reapply the canonical profile", async () => {
    const custom = structuredClone(defaultManagedMeilisearchSettings);
    custom.pagination.maxTotalHits = 250;
    stored.set("meilisearch_settings_profile_v2", custom);
    await service.retry();
    expect(stored.get("meilisearch_settings_profile_v2")).toEqual(custom);
    stored.delete("meilisearch_settings_application_v2");
    await service.reset();
    expect(stored.get("meilisearch_settings_profile_v2")).toEqual(defaultManagedMeilisearchSettings);
  });
});
