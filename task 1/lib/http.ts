export function jsonError(status: number, error: string, details?: unknown) {
  return Response.json(
    {
      error,
      ...(details ? { details } : {})
    },
    { status }
  );
}

export function sseEvent(event: string, data: Record<string, unknown>) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
