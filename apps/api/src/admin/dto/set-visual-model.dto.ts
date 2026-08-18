import { ApiProperty } from "@nestjs/swagger";
import type { VisualModel } from "@samplehub/contracts";
import { IsIn } from "class-validator";

export class SetVisualModelDto {
  @ApiProperty({ enum: ["siglip2", "dinov2", "dinov3"] })
  @IsIn(["siglip2", "dinov2", "dinov3"])
  declare model: VisualModel;
}
