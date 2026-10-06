export async function getStaticProps() {
  return { props: { time: Date.now() }, revalidate: 3600 }
}

export default function Page({ time }: { time: number }) {
  return <p id="pages">pages:{time}</p>
}
