import { headers } from 'next/headers'

export default async function Page() {
  const value = (await headers()).get('x-from-middleware')
  return <p id="header">header:{value}</p>
}
