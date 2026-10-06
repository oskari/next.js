export async function GET() {
  return Response.json({ hello: 'world' })
}

export async function POST(request: Request) {
  return Response.json({ echo: await request.text() })
}
