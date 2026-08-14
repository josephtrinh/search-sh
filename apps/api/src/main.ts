import "dotenv/config";
import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "./app.module";
import { getConfig } from "./common/config";
async function bootstrap() {
  const config = getConfig();
  const app = await NestFactory.create(AppModule, { cors: { origin: ["http://127.0.0.1:3000", "http://localhost:3000"] } });
  app.setGlobalPrefix("v1");
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  const document = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle("SampleHub Search API").setVersion("1.0").build());
  SwaggerModule.setup("docs", app, document);
  await app.listen(config.API_PORT, config.API_HOST);
}
void bootstrap();
