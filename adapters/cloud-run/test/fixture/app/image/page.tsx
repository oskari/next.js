import Image from 'next/image'
import photo from '../../public/photo.png'

export default function Page() {
  return (
    <>
      <Image id="public" src="/photo.png" width={600} height={400} alt="" />
      <Image id="static" src={photo} width={600} alt="" />
    </>
  )
}
