import Image from "next/image";

/** The briefcase mark: an espresso tile (never a white background) with the leather case on it. */
export function LogoMark({ size = 32 }: { size?: number }) {
  return (
    <Image
      src="/logo.png"
      alt=""
      width={size}
      height={size}
      className="shrink-0"
    />
  );
}
