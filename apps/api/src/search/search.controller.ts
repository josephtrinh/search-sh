import { BadRequestException, Body, Controller, Get, Param, Post, UploadedFile, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { memoryStorage } from "multer";
import { SearchService } from "./search.service";

@Controller()
export class SearchController {
  constructor(private readonly searchService: SearchService) {}
  @Post("search")
  @UseInterceptors(FileInterceptor("image", { storage: memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 },
    fileFilter: (_request, file, callback) => callback(file.mimetype.match(/^image\/(jpeg|png|webp)$/) ? null : new BadRequestException("Image must be JPEG, PNG, or WebP"), true) }))
  search(@Body() body: Record<string, unknown>, @UploadedFile() image?: Express.Multer.File) { return this.searchService.search(body, image); }
  @Get("groups/:groupId") group(@Param("groupId") groupId: string) { return this.searchService.group(groupId); }
  @Get("products/:id") product(@Param("id") id: string) { return this.searchService.product(id); }
}
