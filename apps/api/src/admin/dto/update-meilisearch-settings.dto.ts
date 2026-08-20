import { Type } from "class-transformer";
import { ArrayMaxSize, ArrayUnique, IsArray, IsInt, IsObject, IsString, Matches, Max, Min, ValidateNested } from "class-validator";

const ATTRIBUTE_PATTERN = /^[A-Za-z0-9_.-]+$/;

class PaginationSettingsDto {
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  maxTotalHits: number;
}

class FacetingSettingsDto {
  @IsInt()
  @Min(1)
  @Max(10_000)
  maxValuesPerFacet: number;

  @IsObject()
  sortFacetValuesBy: Record<string, "alpha" | "count">;
}

export class UpdateMeilisearchSettingsDto {
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(256)
  @IsString({ each: true })
  @Matches(ATTRIBUTE_PATTERN, { each: true })
  displayedAttributes: string[];

  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(256)
  @IsString({ each: true })
  @Matches(ATTRIBUTE_PATTERN, { each: true })
  searchableAttributes: string[];

  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(256)
  @IsString({ each: true })
  @Matches(ATTRIBUTE_PATTERN, { each: true })
  filterableAttributes: string[];

  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(256)
  @IsString({ each: true })
  @Matches(ATTRIBUTE_PATTERN, { each: true })
  sortableAttributes: string[];

  @ValidateNested()
  @Type(() => PaginationSettingsDto)
  pagination: PaginationSettingsDto;

  @ValidateNested()
  @Type(() => FacetingSettingsDto)
  faceting: FacetingSettingsDto;
}
