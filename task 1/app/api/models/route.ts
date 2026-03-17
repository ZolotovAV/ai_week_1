import { getServerConfig } from "@/lib/config";
import { buildModelCatalog } from "@/lib/models";

export const runtime = "nodejs";

export async function GET() {
  try {
    const config = getServerConfig();

    return Response.json({
      defaultModel: config.defaultModel,
      models: buildModelCatalog(config.defaultModel, config.allowedModels)
    });
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Server configuration error."
      },
      { status: 500 }
    );
  }
}
