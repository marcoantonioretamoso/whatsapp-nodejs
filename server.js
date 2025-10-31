import express from "express";
import cors from "cors";
import { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } from "@whiskeysockets/baileys";
import qrcode from "qrcode";

const app = express();
app.use(cors());
app.use(express.json());

let currentQR = null;
let isConnected = false;
let sock = null;

// Función principal de WhatsApp
async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("./session");
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    // Opciones para manejar la reconexión
    markOnlineOnConnect: false,
    retryRequestDelayMs: 1000,
    maxRetries: 3,
    // delayBetweenTries: 1000, // Opcional
  });

  sock.ev.on("connection.update", async (update) => {
    console.log("🔍 Evento connection.update recibido:", update);

    const { qr, connection, lastDisconnect } = update;

    if (qr) {
      console.log("⚡ Nuevo QR generado");
      currentQR = await qrcode.toDataURL(qr);
    }

    if (connection === "open") {
      isConnected = true;
      console.log("✅ WhatsApp conectado correctamente");
      currentQR = null;
    }

    if (connection === "close") {
      isConnected = false;
      const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== 401;
      console.log("❌ Conexión cerrada. Reconectando:", shouldReconnect);
      if (shouldReconnect) {
        setTimeout(startWhatsApp, 3000);
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);
}

// Endpoint para obtener el QR actual
app.get("/qr", async (req, res) => {
  console.log("📲 Solicitud de QR recibida");

  if (currentQR) {
    return res.json({ qr: currentQR });
  } else if (isConnected) {
    return res.json({ message: "Conectado ✅" });
  } else {
    return res.status(404).json({ message: "QR no disponible aún" });
  }
});

// Inicializar servidor
const PORT = 3001;
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
  startWhatsApp();
});