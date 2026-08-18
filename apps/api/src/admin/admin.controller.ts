import { BadRequestException, Body, ConflictException, Controller, Delete, Get, NotFoundException, Param, Patch, Post, UploadedFile, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Queue } from "bullmq";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { z } from "zod";
import { defaultRankingConfig } from "@samplehub/contracts";
import { getConfig, redisConnection, WORKSPACE_ROOT } from "../common/config";
import { StateService } from "../state/state.service";
import { SearchService } from "../search/search.service";
import { SetVisualModelDto } from "./dto/set-visual-model.dto";
import { StartIndexRunDto } from "./dto/start-index-run.dto";
import { SetIndexScopeDto } from "./dto/set-index-scope.dto";

const RankingSchema = z.object({ version: z.literal(2), textKeywordWeight: z.number().min(0), textSemanticWeight: z.number().min(0), textVisualWeight: z.number().min(0), combinedKeywordWeight: z.number().min(0), combinedSemanticWeight: z.number().min(0), combinedVisualTextWeight: z.number().min(0), combinedImageWeight: z.number().min(0) })
  .refine((value) => value.textKeywordWeight + value.textSemanticWeight + value.textVisualWeight > 0, "At least one text-only weight must be positive")
  .refine((value) => value.combinedKeywordWeight + value.combinedSemanticWeight + value.combinedVisualTextWeight + value.combinedImageWeight > 0, "At least one combined weight must be positive");
const EvalQuerySchema = z.object({ label: z.string().min(1).max(200), queryText: z.string().max(500).optional(), language: z.enum(["en", "zh", "mixed"]), modality: z.enum(["text", "image", "combined"]), filters: z.record(z.string(), z.array(z.string())).default({}) });

@ApiTags("admin")
@Controller("admin")
export class AdminController {
  private readonly queue = new Queue("catalog-indexing", { connection: redisConnection() });
  constructor(private readonly state: StateService, private readonly search: SearchService) {}
  @Get("ranking") ranking() { return this.state.getRanking(); }
  @Patch("ranking") setRanking(@Body() body: unknown) { return this.state.setRanking(RankingSchema.parse(body)); }
  @Get("visual-model")
  @ApiOperation({ summary: "Get the active visual search model and readiness" })
  @ApiOkResponse({ description: "Visual model status" })
  visualModel() { return this.search.visualModelStatus(); }
  @Patch("visual-model")
  @ApiOperation({ summary: "Select the active visual search model" })
  @ApiOkResponse({ description: "Updated visual model status" })
  setVisualModel(@Body() body: SetVisualModelDto) {
    return this.search.setVisualModel(body.model);
  }
  @Get("index-scope")
  indexScope() { return this.search.indexScopeStatus(); }
  @Patch("index-scope")
  setIndexScope(@Body() body: SetIndexScopeDto) { return this.search.setIndexScope(body.scope); }
  @Get("index-runs") runs() { return this.state.listIndexRuns(); }
  @Get("index-runs/:id") run(@Param("id") id: string) { return this.state.getIndexRun(id); }
  @Post("index-runs")
  @ApiOperation({ summary: "Start a catalog index or specialized backfill run" })
  @ApiCreatedResponse({ description: "Queued index run" })
  async start(@Body() body: StartIndexRunDto) {
    const mode = body.mode;
    const fingerprint = mode === "visual_backfill" ? getConfig().DINOV2_FINGERPRINT
      : mode === "dinov3_backfill" ? getConfig().DINOV3_FINGERPRINT
        : mode === "caption_backfill" ? getConfig().CAPTION_BACKFILL_FINGERPRINT : undefined;
    const generation = mode === "limited_full" ? body.generation ?? "current" : mode === "full" ? "current" : undefined;
    const productLimit = mode === "limited_full" ? body.productLimit ?? 10_000 : undefined;
    const run = this.state.createIndexRun(mode, fingerprint, { visualGeneration: generation, productLimit });
    await this.queue.add(mode, { runId: run.id, mode, generation, productLimit }, { jobId: run.id, attempts: 1, removeOnComplete: 100, removeOnFail: 100 });
    return run;
  }
  @Delete("index-runs/:id")
  @ApiOperation({ summary: "Cancel a queued or active index run" })
  @ApiOkResponse({ description: "Cancellation requested or queued run cancelled" })
  async cancel(@Param("id") id: string) {
    const existing = this.state.getIndexRun(id);
    if (!existing) throw new NotFoundException("Index run not found");
    if (["completed", "failed", "cancelled"].includes(existing.status)) {
      throw new ConflictException(`Cannot cancel an index run with status ${existing.status}`);
    }
    this.state.requestCancellation(id);
    const job = await this.queue.getJob(id);
    if (!job) return existing.status === "queued" ? this.state.markCancelled(id) : this.state.getIndexRun(id);
    const jobState = await job.getState();
    if (["unknown", "completed", "failed"].includes(jobState)) return this.state.markCancelled(id);
    if (["waiting", "delayed", "prioritized", "waiting-children"].includes(jobState)) {
      try {
        await job.remove();
        return this.state.markCancelled(id);
      } catch {
        // The worker may have claimed the job between getState() and remove().
        return this.state.getIndexRun(id);
      }
    }
    return this.state.getIndexRun(id);
  }
  @Get("index-status") async indexStatus() {
    return this.search.indexScopeStatus();
  }
  @Get("evaluation/queries") evaluationQueries() { return this.state.raw().prepare("SELECT * FROM evaluation_queries ORDER BY created_at DESC").all(); }
  @Post("evaluation/queries") createEvaluationQuery(@Body() body: unknown) {
    const value = EvalQuerySchema.parse(body); const id = randomUUID();
    this.state.raw().prepare("INSERT INTO evaluation_queries(id,label,query_text,language,modality,filters_json) VALUES(?,?,?,?,?,?)")
      .run(id, value.label, value.queryText ?? null, value.language, value.modality, JSON.stringify(value.filters));
    return { id, ...value };
  }
  @Post("evaluation/queries/:id/fixture")
  @UseInterceptors(FileInterceptor("image", { limits: { fileSize: 10 * 1024 * 1024, files: 1 } }))
  saveFixture(@Param("id") id: string, @UploadedFile() file?: Express.Multer.File) {
    if (!file || !file.mimetype.match(/^image\/(jpeg|png|webp)$/)) throw new BadRequestException("A JPEG, PNG, or WebP fixture is required");
    const extension = file.mimetype.split("/")[1]!.replace("jpeg", "jpg"); const dir = resolve(WORKSPACE_ROOT, "data/evaluation"); mkdirSync(dir, { recursive: true });
    const path = resolve(dir, `${id}.${extension}`); writeFileSync(path, file.buffer);
    this.state.raw().prepare("UPDATE evaluation_queries SET fixture_path=? WHERE id=?").run(path, id); return { id, fixturePath: path };
  }
  @Post("evaluation/queries/:id/judgments") judgment(@Param("id") queryId: string, @Body() body: unknown) {
    const value = z.object({ groupId: z.string().min(1), grade: z.number().int().min(0).max(2) }).parse(body);
    this.state.raw().prepare(`INSERT INTO judgments(query_id,group_id,grade,updated_at) VALUES(?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(query_id,group_id) DO UPDATE SET grade=excluded.grade,updated_at=CURRENT_TIMESTAMP`).run(queryId, value.groupId, value.grade);
    return { queryId, ...value };
  }
  @Get("evaluation/runs") evaluationRuns() { return this.state.raw().prepare("SELECT * FROM evaluation_runs ORDER BY created_at DESC LIMIT 50").all(); }
  @Post("evaluation/runs") async createEvaluationRun() {
    const id = randomUUID();
    const visualStatus = await this.search.visualModelStatus();
    const visualModel = visualStatus.active;
    this.state.raw().prepare("INSERT INTO evaluation_runs(id,config_json,status) VALUES(?,?,'running')").run(id, JSON.stringify({ ranking: this.state.getRanking(), visualModel, generation: visualStatus.generation, indexScope: visualStatus.scope }));
    try {
      const report = await this.evaluate();
      this.state.raw().prepare("UPDATE evaluation_runs SET status='completed',report_json=?,finished_at=CURRENT_TIMESTAMP WHERE id=?").run(JSON.stringify(report), id);
      return { id, status: "completed", report };
    } catch (error) {
      this.state.raw().prepare("UPDATE evaluation_runs SET status='failed',report_json=?,finished_at=CURRENT_TIMESTAMP WHERE id=?").run(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), id);
      throw error;
    }
  }
  private async evaluate() {
    const visualStatus = await this.search.visualModelStatus();
    const visualModel = visualStatus.active;
    const queries = this.state.raw().prepare("SELECT * FROM evaluation_queries ORDER BY created_at").all() as Array<Record<string, unknown>>;
    const rows: Array<Record<string, unknown>> = [];
    for (const query of queries) {
      const judgments = this.state.raw().prepare("SELECT group_id,grade FROM judgments WHERE query_id=?").all(query.id) as Array<{ group_id: string; grade: number }>;
      const grades = new Map(judgments.map((item) => [item.group_id, item.grade]));
      const modality = String(query.modality); const modes = modality === "text" ? ["keyword", "text_hybrid", ...(visualModel === "siglip2" ? ["text_visual"] : []), "auto"] : modality === "image" ? ["image_visual"] : ["text_hybrid", "image_visual", "auto"];
      let file: Express.Multer.File | undefined;
      if (query.fixture_path) {
        const path = String(query.fixture_path); const extension = extname(path).toLowerCase();
        file = { fieldname: "image", originalname: basename(path), encoding: "7bit", mimetype: extension === ".png" ? "image/png" : extension === ".webp" ? "image/webp" : "image/jpeg", size: 0, destination: "", filename: basename(path), path, buffer: readFileSync(path), stream: undefined as never };
        file.size = file.buffer.length;
      }
      for (const mode of modes) {
        if (mode === "image_visual" && !file) continue;
        const response = await this.search.search({ query: query.query_text ? String(query.query_text) : undefined, mode, filters: String(query.filters_json), limit: 10 }, file);
        const actual = response.hits.map((hit) => grades.get(hit.groupId) ?? 0); const ideal = [...grades.values()].sort((a, b) => b - a).slice(0, 10);
        rows.push({ queryId: query.id, label: query.label, language: query.language, modality, mode, ndcgAt10: this.ndcg(actual, ideal) });
      }
    }
    const grouped = new Map<string, number[]>(); for (const row of rows) { const key = `${row.mode}:${row.language}:${row.modality}`; grouped.set(key, [...(grouped.get(key) ?? []), Number(row.ndcgAt10)]); }
    return { metric: "nDCG@10", generatedAt: new Date().toISOString(), visualModel, visualGeneration: visualStatus.generation, indexScope: visualStatus.scope, queries: rows,
      aggregates: [...grouped.entries()].map(([key, values]) => ({ slice: key, queryCount: values.length, ndcgAt10: values.reduce((sum, value) => sum + value, 0) / values.length })) };
  }
  private ndcg(actual: number[], ideal: number[]) {
    const dcg = (values: number[]) => values.slice(0, 10).reduce((sum, grade, index) => sum + (Math.pow(2, grade) - 1) / Math.log2(index + 2), 0);
    const denominator = dcg(ideal); return denominator === 0 ? 0 : dcg(actual) / denominator;
  }
}
