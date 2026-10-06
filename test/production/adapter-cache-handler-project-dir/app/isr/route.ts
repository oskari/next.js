export const revalidate = 60

export async function GET() {
  return Response.json({ time: Date.now() })
}
