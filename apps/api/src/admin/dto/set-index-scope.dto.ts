import { ApiProperty } from "@nestjs/swagger";
import type { IndexScope } from "@samplehub/contracts";
import { IsIn } from "class-validator";

export class SetIndexScopeDto {
  @ApiProperty({ enum: ["stable", "preview_legacy", "preview_current"] })
  @IsIn(["stable", "preview_legacy", "preview_current"])
  declare scope: IndexScope;
}
