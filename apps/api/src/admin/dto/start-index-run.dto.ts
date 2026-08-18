import { ApiProperty } from "@nestjs/swagger";
import type { IndexRunMode } from "@samplehub/contracts";
import { IsIn } from "class-validator";

export class StartIndexRunDto {
  @ApiProperty({
    enum: ["full", "incremental", "visual_backfill", "dinov3_backfill"],
  })
  @IsIn(["full", "incremental", "visual_backfill", "dinov3_backfill"])
  declare mode: IndexRunMode;
}
