import { Suspense } from 'react'
import { connection } from 'next/server'
import { cacheLife, cacheTag } from 'next/cache'

async function getTime() {
  'use cache: remote'
  cacheTag('remote')
  cacheLife('hours')
  return Date.now()
}

async function Time() {
  await connection()
  return <p id="remote">remote:{await getTime()}</p>
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <Time />
    </Suspense>
  )
}
