/** Service Binding 上游响应原样回传（避免 Hono c.json 重组丢失头） */
export async function passthroughResponse(upstream: Response): Promise<Response> {
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
}
