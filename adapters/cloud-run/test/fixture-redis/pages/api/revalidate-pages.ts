import type { NextApiRequest, NextApiResponse } from 'next'

export default async function handler(
  _req: NextApiRequest,
  res: NextApiResponse
) {
  await res.revalidate('/isr')
  res.json({ revalidated: true })
}
