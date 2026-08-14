import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AdminModule } from "./admin/admin.module";
import { HealthModule } from "./health/health.module";
import { SearchModule } from "./search/search.module";
import { StateModule } from "./state/state.module";
@Module({ imports: [ConfigModule.forRoot({ isGlobal: true, envFilePath: ["../../.env", ".env"] }), StateModule, HealthModule, SearchModule, AdminModule] })
export class AppModule {}
