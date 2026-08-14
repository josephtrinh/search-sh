import { Controller, Get } from "@nestjs/common";
import { getConfig } from "../common/config";
@Controller("health")
export class HealthController {
  @Get()
  async health() {
    const config = getConfig();
    const [meili, inference] = await Promise.allSettled([
      fetch(`${config.MEILI_URL}/health`).then((response) => response.ok),
      fetch(`${config.INFERENCE_URL}/health`).then((response) => response.ok),
    ]);
    return { status: "ok", dependencies: { meilisearch: meili.status === "fulfilled" && meili.value, inference: inference.status === "fulfilled" && inference.value } };
  }
}
