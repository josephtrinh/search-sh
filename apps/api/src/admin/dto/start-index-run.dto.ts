import { ApiProperty } from "@nestjs/swagger";
import type { IndexRunMode, VisualGeneration } from "@samplehub/contracts";
import { IsIn, IsInt, IsOptional, Max, Min, ValidateIf } from "class-validator";

export class StartIndexRunDto {
  @ApiProperty({
    enum: [
      "full",
      "limited_full",
      "incremental",
      "visual_backfill",
      "dinov3_backfill",
      "caption_backfill",
    ],
  })
  @IsIn([
    "full",
    "limited_full",
    "incremental",
    "visual_backfill",
    "dinov3_backfill",
    "caption_backfill",
  ])
  declare mode: IndexRunMode;

  @ApiProperty({ enum: ["legacy", "current"], required: false, default: "current" })
  @ValidateIf((value: StartIndexRunDto) => value.mode === "limited_full")
  @IsOptional()
  @IsIn(["legacy", "current"])
  declare generation?: VisualGeneration;

  @ApiProperty({ minimum: 1, maximum: 25000, required: false, default: 10000 })
  @ValidateIf((value: StartIndexRunDto) => value.mode === "limited_full")
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(25000)
  declare productLimit?: number;
}
