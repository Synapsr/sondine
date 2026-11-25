import { QrCode } from "../../components/qr-code";
import { Section, Specimen } from "../section";

const pairing =
  "sondine://pair?v=1&pin=q8Hf3XoVJm2Yt0nKp9bLwE4cRz7uAaSdGhTjNkMlPvQ&token=Zx1Cv2Bn3Mq4Wl5Ek6Rj7Th8Yg9Uf0Id-Os_PaLbKcJdIeHfGg&name=Sondine+X7k2&port=51234&addr=192.168.1.24";

export default function QrCodeSection() {
  return (
    <Section id="qr-code" title="QR code">
      <Specimen label="Short and long">
        <QrCode value="Sondine" label="Sondine" className="w-[8rem]" />
        <QrCode value={pairing} label="Appairer un iPhone" className="w-[12rem]" />
      </Specimen>
    </Section>
  );
}
