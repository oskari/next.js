import { NextResponse, type NextRequest } from 'next/server'

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl
  if (pathname === '/mw-redirect') {
    return NextResponse.redirect(new URL('/', request.url))
  }
  if (pathname === '/mw-rewrite') {
    return NextResponse.rewrite(new URL('/blog/rewritten', request.url))
  }
  if (pathname === '/mw-respond') {
    return new NextResponse('from proxy', { status: 418 })
  }
  const headers = new Headers(request.headers)
  headers.set('x-from-middleware', 'hi')
  return NextResponse.next({ request: { headers } })
}

export const config = {
  matcher: ['/dynamic', '/mw-redirect', '/mw-rewrite', '/mw-respond'],
}
