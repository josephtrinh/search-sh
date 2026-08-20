import { Module } from "@nestjs/common";
import { AdminController } from "./admin.controller";
import { SearchModule } from "../search/search.module";
import { MeilisearchSettingsService } from "./meilisearch-settings.service";
@Module({ imports: [SearchModule], controllers: [AdminController], providers: [MeilisearchSettingsService] })
export class AdminModule {}
