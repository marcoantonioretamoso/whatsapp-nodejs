import express from "express";
import cors from "cors";
import { InstanceManager } from './instanceManager.js';

const app = express();
app.use(cors());
app.use(express.json());

const instanceManager = new InstanceManager();

// Inicializar el manager al iniciar la app
instanceManager.initialize().then(() => {
  console.log('✅ Database y Instance Manager inicializados');
});

// Middleware para validar token e instancia (SOLO para envío de mensajes)
async function validateTokenAndInstance(req, res, next) {
  const { token, instance_id = 'default' } = req.body; // instance_id por defecto

  if (!token) {
    return res.status(400).json({
      success: false,
      error: "Token es requerido"
    });
  }

  const isValid = await instanceManager.validateTokenAndInstance(token, instance_id);
  
  if (!isValid) {
    return res.status(401).json({
      success: false,
      error: "Token o instancia inválidos"
    });
  }

  next();
}

// Endpoint MEJORADO para obtener el QR - NO requiere instance_id inicialmente
// app.get("/qr", async (req, res) => {
//   const { token } = req.query;

//   if (!token) {
//     return res.status(400).json({
//       success: false,
//       error: "Token es requerido"
//     });
//   }

//   try {
//     console.log(`📲 Solicitud de QR para token: ${token}`);

//     // Verificar si ya existe una instancia conectada para este token
//     const existingInstance = await instanceManager.getConnectedInstance(token);
    
//     if (existingInstance) {
//       // Si ya existe una instancia conectada, devolverla
//       return res.json({
//         connected: true,
//         message: "Ya existe una instancia conectada",
//         instance_id: existingInstance.instance_id,
//         user: existingInstance.userInfo
//       });
//     }

//     // Si no existe, crear una nueva instancia con un ID único
//     const instanceId = `instance_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
//     // Iniciar WhatsApp para esta instancia
//     await instanceManager.startWhatsApp(token, instanceId);
//     // await instanceManager.createInstance(token, instanceId)
    
//     // Obtener el QR
//     const qr = instanceManager.getInstanceQR(token, instanceId);
//     const status = instanceManager.getInstanceStatus(token, instanceId);

//     if (qr) {
//       return res.json({ 
//         qr: qr, 
//         connected: false,
//         instance_id: instanceId,
//         status: 'qr_generated',
//         message: "Escanea el QR para conectar"
//       });
//     } else {
//       return res.status(404).json({
//         message: "QR no disponible aún, intenta de nuevo en unos segundos",
//         connected: false,
//         instance_id: instanceId,
//         status: status
//       });
//     }
//   } catch (error) {
//     console.error("Error en /qr:", error);
//     res.status(500).json({
//       success: false,
//       error: error.message
//     });
//   }
// });
// Endpoint para obtener QR
app.get("/qr", async (req, res) => {
    const { token } = req.query;

    if (!token) {
        return res.status(400).json({
            success: false,
            error: "Token es requerido"
        });
    }

    try {
        console.log(`📲 Solicitud de QR para token: ${token}`);

        // Verificar si ya existe una instancia conectada para este token
        const existingInstance = await instanceManager.getConnectedInstance(token);
        if (existingInstance) {
            return res.json({
                connected: true,
                message: "Ya existe una instancia conectada",
                instance_id: existingInstance.instance_id,
                user: existingInstance.userInfo
            });
        }

        // Si no existe, crear un ID de instancia único
        const instanceId = `instance_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // Iniciar sesión de WhatsApp y esperar el QR
        const qrResult = await instanceManager.startWhatsAppSession(token, instanceId);

        res.json({
            qr: qrResult.qr,
            connected: false,
            instance_id: instanceId,
            status: 'qr_generated',
            message: "Escanea el QR para conectar"
        });

    } catch (error) {
        console.error("Error en /qr:", error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Endpoint para verificar el estado de una instancia específica
app.get("/status", async (req, res) => {
  const { token, instance_id } = req.query;

  if (!token) {
    return res.status(400).json({
      success: false,
      error: "Token es requerido"
    });
  }

  try {
    let instanceInfo;
    
    if (instance_id) {
      // Verificar una instancia específica
      const isValid = await instanceManager.validateTokenAndInstance(token, instance_id);
      if (!isValid) {
        return res.status(401).json({
          success: false,
          error: "Token o instancia inválidos"
        });
      }
      instanceInfo = {
        instance_id: instance_id,
        status: instanceManager.getInstanceStatus(token, instance_id),
        userInfo: instanceManager.getInstanceUserInfo(token, instance_id)
      };
    } else {
      // Buscar cualquier instancia conectada para este token
      instanceInfo = await instanceManager.getConnectedInstance(token);
    }

    if (instanceInfo && instanceInfo.status === 'connected') {
      res.json({
        connected: true,
        instance_id: instanceInfo.instance_id,
        user: instanceInfo.userInfo,
        status: 'connected'
      });
    } else {
      res.json({
        connected: false,
        instance_id: instanceInfo?.instance_id,
        status: instanceInfo?.status || 'not_found',
        message: "No hay instancias conectadas"
      });
    }
  } catch (error) {
    console.error("Error en /status:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get("/restart", async (req, res) => {
  const { token, instance_id } = req.query;

  if (!token || !instance_id) {
    return res.status(400).json({
      success: false,
      error: "Token e instance_id son requeridos"
    });
  }

  try {
    console.log(`🔄 Reiniciando instancia ${instance_id} para token ${token}...`);

    // 1️⃣ Validar token e instancia
    // const isValid = await instanceManager.validateTokenAndInstance(token, instance_id);
    // if (!isValid) {
    //   return res.status(401).json({
    //     success: false,
    //     error: "Token o instancia inválidos"
    //   });
    // }

    // 2️⃣ Desconectar instancia anterior si existe
    await instanceManager.disconnectInstance(token, instance_id);

    // 3️⃣ Reiniciar una nueva sesión de WhatsApp
    const qrResult = await instanceManager.startWhatsAppSession(token, instance_id);

    console.log(`✅ Instancia ${instance_id} reiniciada correctamente`);

    res.json({
      success: true,
      message: "Instancia reiniciada correctamente. Escanea el nuevo QR.",
      qr: qrResult.qr,
      instance_id: instance_id,
      status: 'qr_generated'
    });

  } catch (error) {
    console.error("❌ Error al reiniciar instancia:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});


// Endpoint para obtener todas las instancias de un usuario
app.get("/instances", async (req, res) => {
  const { token } = req.query;

  if (!token) {
    return res.status(400).json({
      success: false,
      error: "Token es requerido"
    });
  }

  try {
    const instances = await instanceManager.getUserInstances(token);
    res.json({
      success: true,
      instances: instances
    });
  } catch (error) {
    console.error("Error en /instances:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Endpoint para enviar mensaje (con validación de token e instancia)
app.post("/send-message", validateTokenAndInstance, async (req, res) => {
  const { token, instance_id = 'default', number, message } = req.body;
  console.log(`📩 Envío de mensaje solicitado para token: ${token}, instancia: ${instance_id}, número: ${number}`);
  // const sock = instanceManager.getInstanceSocket(instance_id);
  const sock = instanceManager.getInstanceSocket(token, instance_id);
 console.log(`🔍 Obteniendo socket para la instancia: ${sock}`);
  if (!sock) {
    return res.status(400).json({
      success: false,
      error: "Instancia no conectada"
    });
  }

  try {
    const cleanNumber = number.replace(/\D/g, '');
    const jid = `${cleanNumber}@s.whatsapp.net`;

    await sock.sendMessage(jid, { text: message });

    // Guardar mensaje en BD
    await instanceManager.saveMessage(
      token, 
      instance_id,
      'system',
      cleanNumber, 
      message,
      'text'
    );

    console.log(`📤 Mensaje enviado a ${cleanNumber} desde ${token}_${instance_id}`);
    res.json({
      success: true,
      message: "Mensaje enviado correctamente",
      to: cleanNumber,
      instance_id: instance_id
    });

  } catch (error) {
    console.error("❌ Error enviando mensaje:", error);
    res.status(500).json({
      success: false,
      error: "Error al enviar mensaje: " + error.message
    });
  }
});

// 2. Enviar mensaje a múltiples números (Broadcast)
app.post("/send-broadcast", validateTokenAndInstance, async (req, res) => {
  const { token, instance_id = 'default', numbers, message } = req.body;
  console.log(`📢 Broadcast solicitado para token: ${token}, instancia: ${instance_id}, números: ${numbers.length}`);
  
  const sock = instanceManager.getInstanceSocket(token, instance_id);
  console.log(`🔍 Obteniendo socket para la instancia: ${sock}`);
  
  if (!sock) {
    return res.status(400).json({
      success: false,
      error: "Instancia no conectada"
    });
  }

  if (!numbers || !Array.isArray(numbers) || numbers.length === 0) {
    return res.status(400).json({
      success: false,
      error: "El campo 'numbers' debe ser un array con al menos un número"
    });
  }

  if (!message) {
    return res.status(400).json({
      success: false,
      error: "El mensaje es requerido"
    });
  }

  try {
    const results = [];

    // Enviar mensajes en secuencia
    for (const number of numbers) {
      try {
        const cleanNumber = number.replace(/\D/g, '');
        const jid = `${cleanNumber}@s.whatsapp.net`;

        await sock.sendMessage(jid, { text: message });
        
        // Guardar mensaje en BD
        await instanceManager.saveMessage(
          token, 
          instance_id,
          'system',
          cleanNumber, 
          message,
          'text'
        );
        
        results.push({ number: cleanNumber, status: "success" });
        console.log(`📤 Mensaje broadcast enviado a ${cleanNumber}`);

        // Pequeña pausa entre mensajes
        await new Promise(resolve => setTimeout(resolve, 100));

      } catch (error) {
        console.error(`❌ Error enviando broadcast a ${number}:`, error.message);
        results.push({
          number: number,
          status: "error",
          error: error.message
        });
      }
    }

    const successCount = results.filter(r => r.status === "success").length;
    const errorCount = results.filter(r => r.status === "error").length;

    res.json({
      success: true,
      message: `Mensajes broadcast enviados: ${successCount} éxitos, ${errorCount} errores`,
      total: numbers.length,
      successCount,
      errorCount,
      details: results,
      instance_id: instance_id
    });

  } catch (error) {
    console.error("❌ Error en broadcast:", error);
    res.status(500).json({
      success: false,
      error: "Error en broadcast: " + error.message
    });
  }
});

// 3. Enviar imagen
app.post("/send-image", validateTokenAndInstance, async (req, res) => {
  const { token, instance_id = 'default', number, image_url, caption } = req.body;
  console.log(`🖼️ Envío de imagen solicitado para token: ${token}, instancia: ${instance_id}, número: ${number}`);
  
  const sock = instanceManager.getInstanceSocket(token, instance_id);
  console.log(`🔍 Obteniendo socket para la instancia: ${sock}`);
  
  if (!sock) {
    return res.status(400).json({
      success: false,
      error: "Instancia no conectada"
    });
  }

  if (!number || !image_url) {
    return res.status(400).json({
      success: false,
      error: "Número y URL de imagen son requeridos"
    });
  }

  try {
    const cleanNumber = number.replace(/\D/g, '');
    const jid = `${cleanNumber}@s.whatsapp.net`;

    await sock.sendMessage(jid, {
      image: { url: image_url },
      caption: caption || "",
      mimetype: 'image/jpeg'
    });

    // Guardar mensaje en BD
    await instanceManager.saveMessage(
      token, 
      instance_id,
      'system',
      cleanNumber, 
      caption || "Imagen enviada",
      'image'
    );

    console.log(`🖼️ Imagen enviada a ${cleanNumber} desde ${token}_${instance_id}`);
    res.json({
      success: true,
      message: "Imagen enviada correctamente",
      to: cleanNumber,
      instance_id: instance_id
    });

  } catch (error) {
    console.error("❌ Error enviando imagen:", error);
    res.status(500).json({
      success: false,
      error: "Error al enviar imagen: " + error.message
    });
  }
});

// 4. Enviar documento/archivo
app.post("/send-document", validateTokenAndInstance, async (req, res) => {
  const { token, instance_id = 'default', number, document_url, fileName, caption } = req.body;
  console.log(`📎 Envío de documento solicitado para token: ${token}, instancia: ${instance_id}, número: ${number}`);
  
  const sock = instanceManager.getInstanceSocket(token, instance_id);
  console.log(`🔍 Obteniendo socket para la instancia: ${sock}`);
  
  if (!sock) {
    return res.status(400).json({
      success: false,
      error: "Instancia no conectada"
    });
  }

  if (!number || !document_url || !fileName) {
    return res.status(400).json({
      success: false,
      error: "Número, URL y nombre de archivo son requeridos"
    });
  }

  try {
    const cleanNumber = number.replace(/\D/g, '');
    const jid = `${cleanNumber}@s.whatsapp.net`;

    await sock.sendMessage(jid, {
      document: { url: document_url },
      fileName: fileName,
      caption: caption || "",
      mimetype: 'application/octet-stream'
    });

    // Guardar mensaje en BD
    await instanceManager.saveMessage(
      token, 
      instance_id,
      'system',
      cleanNumber, 
      caption || `Documento: ${fileName}`,
      'document'
    );

    console.log(`📎 Documento enviado a ${cleanNumber} desde ${token}_${instance_id}`);
    res.json({
      success: true,
      message: "Documento enviado correctamente",
      to: cleanNumber,
      instance_id: instance_id
    });

  } catch (error) {
    console.error("❌ Error enviando documento:", error);
    res.status(500).json({
      success: false,
      error: "Error al enviar documento: " + error.message
    });
  }
});

// 5. Enviar audio
app.post("/send-audio", validateTokenAndInstance, async (req, res) => {
  const { token, instance_id = 'default', number, audioUrl } = req.body;
  console.log(`🎵 Envío de audio solicitado para token: ${token}, instancia: ${instance_id}, número: ${number}`);
  
  const sock = instanceManager.getInstanceSocket(token, instance_id);
  console.log(`🔍 Obteniendo socket para la instancia: ${sock}`);
  
  if (!sock) {
    return res.status(400).json({
      success: false,
      error: "Instancia no conectada"
    });
  }

  if (!number || !audioUrl) {
    return res.status(400).json({
      success: false,
      error: "Número y URL de audio son requeridos"
    });
  }

  try {
    const cleanNumber = number.replace(/\D/g, '');
    const jid = `${cleanNumber}@s.whatsapp.net`;

    await sock.sendMessage(jid, {
      audio: { url: audioUrl },
      mimetype: 'audio/mp4',
      ptt: true
    });

    // Guardar mensaje en BD
    await instanceManager.saveMessage(
      token, 
      instance_id,
      'system',
      cleanNumber, 
      "Audio enviado",
      'audio'
    );

    console.log(`🎵 Audio enviado a ${cleanNumber} desde ${token}_${instance_id}`);
    res.json({
      success: true,
      message: "Audio enviado correctamente",
      to: cleanNumber,
      instance_id: instance_id
    });

  } catch (error) {
    console.error("❌ Error enviando audio:", error);
    res.status(500).json({
      success: false,
      error: "Error al enviar audio: " + error.message
    });
  }
});

// 6. Enviar video
app.post("/send-video", validateTokenAndInstance, async (req, res) => {
  const { token, instance_id = 'default', number, videoUrl, caption } = req.body;
  console.log(`🎥 Envío de video solicitado para token: ${token}, instancia: ${instance_id}, número: ${number}`);
  
  const sock = instanceManager.getInstanceSocket(token, instance_id);
  console.log(`🔍 Obteniendo socket para la instancia: ${sock}`);
  
  if (!sock) {
    return res.status(400).json({
      success: false,
      error: "Instancia no conectada"
    });
  }

  if (!number || !videoUrl) {
    return res.status(400).json({
      success: false,
      error: "Número y URL de video son requeridos"
    });
  }

  try {
    const cleanNumber = number.replace(/\D/g, '');
    const jid = `${cleanNumber}@s.whatsapp.net`;

    await sock.sendMessage(jid, {
      video: { url: videoUrl },
      caption: caption || "",
      mimetype: 'video/mp4'
    });

    // Guardar mensaje en BD
    await instanceManager.saveMessage(
      token, 
      instance_id,
      'system',
      cleanNumber, 
      caption || "Video enviado",
      'video'
    );

    console.log(`🎥 Video enviado a ${cleanNumber} desde ${token}_${instance_id}`);
    res.json({
      success: true,
      message: "Video enviado correctamente",
      to: cleanNumber,
      instance_id: instance_id
    });

  } catch (error) {
    console.error("❌ Error enviando video:", error);
    res.status(500).json({
      success: false,
      error: "Error al enviar video: " + error.message
    });
  }
});

// 7. Enviar ubicación
app.post("/send-location", validateTokenAndInstance, async (req, res) => {
  const { token, instance_id = 'default', number, latitude, longitude, name } = req.body;
  console.log(`📍 Envío de ubicación solicitado para token: ${token}, instancia: ${instance_id}, número: ${number}`);
  
  const sock = instanceManager.getInstanceSocket(token, instance_id);
  console.log(`🔍 Obteniendo socket para la instancia: ${sock}`);
  
  if (!sock) {
    return res.status(400).json({
      success: false,
      error: "Instancia no conectada"
    });
  }

  if (!number || !latitude || !longitude) {
    return res.status(400).json({
      success: false,
      error: "Número, latitud y longitud son requeridos"
    });
  }

  try {
    const cleanNumber = number.replace(/\D/g, '');
    const jid = `${cleanNumber}@s.whatsapp.net`;

    await sock.sendMessage(jid, {
      location: {
        degreesLatitude: latitude,
        degreesLongitude: longitude,
        name: name || "Ubicación"
      }
    });

    // Guardar mensaje en BD
    await instanceManager.saveMessage(
      token, 
      instance_id,
      'system',
      cleanNumber, 
      `Ubicación: ${name || "Sin nombre"} (${latitude}, ${longitude})`,
      'location'
    );

    console.log(`📍 Ubicación enviada a ${cleanNumber} desde ${token}_${instance_id}`);
    res.json({
      success: true,
      message: "Ubicación enviada correctamente",
      to: cleanNumber,
      instance_id: instance_id
    });

  } catch (error) {
    console.error("❌ Error enviando ubicación:", error);
    res.status(500).json({
      success: false,
      error: "Error al enviar ubicación: " + error.message
    });
  }
});

// 8. Enviar contacto
app.post("/send-contact", validateTokenAndInstance, async (req, res) => {
  const { token, instance_id = 'default', number, contactNumber, contactName } = req.body;
  console.log(`👤 Envío de contacto solicitado para token: ${token}, instancia: ${instance_id}, número: ${number}`);
  
  const sock = instanceManager.getInstanceSocket(token, instance_id);
  console.log(`🔍 Obteniendo socket para la instancia: ${sock}`);
  
  if (!sock) {
    return res.status(400).json({
      success: false,
      error: "Instancia no conectada"
    });
  }

  if (!number || !contactNumber || !contactName) {
    return res.status(400).json({
      success: false,
      error: "Número, contacto y nombre de contacto son requeridos"
    });
  }

  try {
    const cleanNumber = number.replace(/\D/g, '');
    const jid = `${cleanNumber}@s.whatsapp.net`;
    const contactJid = `${contactNumber.replace(/\D/g, '')}@s.whatsapp.net`;

    await sock.sendMessage(jid, {
      contacts: {
        contacts: [{
          displayName: contactName,
          vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:${contactName}\nTEL:${contactNumber}\nEND:VCARD`
        }]
      }
    });

    // Guardar mensaje en BD
    await instanceManager.saveMessage(
      token, 
      instance_id,
      'system',
      cleanNumber, 
      `Contacto compartido: ${contactName} (${contactNumber})`,
      'contact'
    );

    console.log(`👤 Contacto enviado a ${cleanNumber} desde ${token}_${instance_id}`);
    res.json({
      success: true,
      message: "Contacto enviado correctamente",
      to: cleanNumber,
      instance_id: instance_id
    });

  } catch (error) {
    console.error("❌ Error enviando contacto:", error);
    res.status(500).json({
      success: false,
      error: "Error al enviar contacto: " + error.message
    });
  }
});

// Endpoint para desconectar una instancia
app.delete("/disconnect", async (req, res) => {
  const { token, instance_id } = req.body;

  if (!token || !instance_id) {
    return res.status(400).json({
      success: false,
      error: "Token e instance_id son requeridos"
    });
  }

  try {
    await instanceManager.disconnectInstance(token, instance_id);
    res.json({
      success: true,
      message: "Instancia desconectada correctamente"
    });
  } catch (error) {
    console.error("Error desconectando instancia:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Endpoint para crear usuario manualmente
app.post("/create-user", async (req, res) => {
  try {
    const { token, name } = req.body;
    if (!token) {
      return res.status(400).json({
        success: false,
        error: "Token es requerido"
      });
    }
    console.log(`🆕 Creando usuario con token: ${token}, nombre: ${name}`);
    await instanceManager.createUser(token, name);
    res.json({
      success: true,
      message: "Usuario creado correctamente"
    });
  } catch (error) {
    console.error("Error creando usuario:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Endpoint mejorado para obtener mensajes
app.get("/messages", async (req, res) => {
    const { token, instance_id, limit = 50, offset = 0 } = req.query;

    if (!token) {
        return res.status(400).json({
            success: false,
            error: "Token es requerido"
        });
    }

    try {
        console.log(`📨 Solicitando mensajes para token: ${token}, instancia: ${instance_id || 'todas'}`);

        // Primero verificar que el usuario existe
        const user = await instanceManager.db.get('SELECT id FROM users WHERE token = ?', token);
        if (!user) {
            return res.status(404).json({
                success: false,
                error: "Token no válido"
            });
        }

        // Si se proporciona instance_id, verificar que existe
        if (instance_id) {
            const instance = await instanceManager.db.get(
                'SELECT id FROM instances WHERE instance_id = ? AND user_id = ?',
                instance_id, user.id
            );
            
            if (!instance) {
                return res.status(404).json({
                    success: false,
                    error: `Instancia "${instance_id}" no encontrada para este token`
                });
            }
        }

        const messages = await instanceManager.getUserMessages(token, null, parseInt(limit), parseInt(offset));

        res.json({
            success: true,
            messages: messages,
            total: messages.length,
            limit: parseInt(limit),
            offset: parseInt(offset),
            user_id: user.id
        });

    } catch (error) {
        console.error("❌ Error obteniendo mensajes:", error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Inicializar servidor
const PORT = 3001;
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
  console.log(`📚 Endpoints actualizados:`);
  console.log(`   GET  /qr?token=TOKEN           - Obtener QR (crea instancia automáticamente)`);
  console.log(`   GET  /status?token=TOKEN       - Verificar estado (puede incluir instance_id)`);
  console.log(`   GET  /instances?token=TOKEN    - Obtener todas las instancias del usuario`);
  console.log(`   POST /send-message             - Enviar mensaje (body: token, instance_id, number, message)`);
  console.log(`   DELETE /disconnect             - Desconectar instancia`);
  console.log(`   POST /create-user              - Crear usuario manualmente`);
});