import spec from "../openapi.yaml";

// Swagger UI from the CDN, pointed at /openapi.json. Pinned so the page
// doesn't change under us.
const SWAGGER_UI = "https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14";

const page = `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${spec.info.title} API</title>
    <link rel="stylesheet" href="${SWAGGER_UI}/swagger-ui.css">
</head>
<body>
    <div id="swagger-ui"></div>
    <script src="${SWAGGER_UI}/swagger-ui-bundle.js"></script>
    <script>
        SwaggerUIBundle({
            url: "/openapi.json",
            dom_id: "#swagger-ui",
            persistAuthorization: true,
        });
    </script>
</body>
</html>`;

export const docsRoutes = {
    "/openapi.json": { GET: async () => Response.json(spec) },
    "/docs": {
        GET: async () =>
            new Response(page, {
                headers: { "Content-Type": "text/html; charset=utf-8" },
            }),
    },
};
