import { cacheLife, cacheTag } from 'next/cache'

async function getTime() {
  'use cache'
  cacheTag('time')
  cacheLife('hours')
  return Date.now()
}

export default async function Page() {
  return <p id="time">time:{await getTime()}</p>
}
