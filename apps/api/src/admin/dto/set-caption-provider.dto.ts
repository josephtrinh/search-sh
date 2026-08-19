import { ApiProperty } from "@nestjs/swagger";
import type { CaptionProvider } from "@samplehub/contracts";
import { IsIn } from "class-validator";

export class SetCaptionProviderDto {
  @ApiProperty({ enum: ["florence", "qwen"] })
  @IsIn(["florence", "qwen"])
  declare provider: CaptionProvider;
}
