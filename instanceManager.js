import { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } from "@whiskeysockets/baileys";
import qrcode from "qrcode";
import path from 'path';
import { fileURLToPath } from 'url';
import { initDatabase } from './database.js';
import fs from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class InstanceManager {
    constructor() {
        this.instances = new Map();
        this.db = null;
    }

    async initialize() {
        this.db = await initDatabase();
        await this.restoreConnectedInstances();
    }
    async getActiveInstance(userToken) {
        try {
            // Buscar en la base de datos una instancia que no esté desconectada
            const instance = await this.db.get(`
            SELECT i.* 
            FROM instances i 
            JOIN users u ON i.user_id = u.id 
            WHERE u.token = ? AND i.status != 'disconnected'
            ORDER BY i.created_at DESC
            LIMIT 1
        `, userToken);

            if (instance) {
                const instanceKey = `${userToken}_${instance.instance_id}`;
                const instanceData = this.instances.get(instanceKey);

                return {
                    instance_id: instance.instance_id,
                    status: instance.status,
                    userInfo: instanceData?.userInfo || null,
                    qr: instanceData?.qr || null
                };
            }
            return null;
        } catch (error) {
            console.error('Error obteniendo instancia activa:', error);
            return null;
        }
    }

    async restoreConnectedInstances() {
        try {
            console.log('🔄 Restaurando instancias conectadas desde la base de datos...');
            const connectedInstances = await this.db.all(`
            SELECT i.instance_id, u.token 
            FROM instances i 
            JOIN users u ON i.user_id = u.id 
            WHERE i.status = 'connected'
        `);

            console.log(`📊 Encontradas ${connectedInstances.length} instancias conectadas en la base de datos.`);

            for (const { instance_id, token } of connectedInstances) {
                console.log(`🔁 Restaurando instancia: ${token}_${instance_id}`);
                try {
                    await this.startWhatsAppSession(token, instance_id);
                } catch (error) {
                    console.error(`❌ Error restaurando instancia ${instance_id}:`, error);
                    // Si no se puede restaurar, actualizar el estado en la base de datos a 'disconnected'
                    await this.updateInstanceStatusInDB(token, instance_id, 'disconnected');
                }
            }
        } catch (error) {
            console.error('Error restaurando instancias conectadas:', error);
        }
    }
    // Crear usuario si no existe
    async createUser(token, name = 'Usuario') {
        try {
            await this.db.run(
                'INSERT OR IGNORE INTO users (token, name) VALUES (?, ?)',
                token, name
            );
            return true;
        } catch (error) {
            console.error('Error creando usuario:', error);
            throw error;
        }
    }

    // Crear nueva instancia para un usuario
    async createInstance(userToken, instanceId) {
        try {
            // Verificar si el usuario existe, si no, crearlo
            await this.createUser(userToken);

            // Verificar si la instancia ya existe
            const user = await this.db.get('SELECT * FROM users WHERE token = ?', userToken);
            const existingInstance = await this.db.get(
                'SELECT * FROM instances WHERE user_id = ? AND instance_id = ?',
                user.id, instanceId
            );

            if (existingInstance) {
                // Si existe, usar esa instancia
                await this.startInstance(instanceId);
                return { success: true, instanceId, message: 'Instancia recuperada' };
            } else {
                // Crear nueva instancia
                await this.db.run(
                    'INSERT INTO instances (user_id, instance_id, status) VALUES (?, ?, ?)',
                    user.id, instanceId, 'initializing'
                );

                await this.startInstance(instanceId);
                return { success: true, instanceId, message: 'Instancia creada' };
            }
        } catch (error) {
            console.error('Error creando instancia:', error);
            throw error;
        }
    }

    // Iniciar instancia de WhatsApp
    async startInstance(instanceId) {
        try {
            const sessionPath = path.join(__dirname, 'sessions', instanceId);

            const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
            const { version } = await fetchLatestBaileysVersion();

            const sock = makeWASocket({
                version,
                auth: state,
                printQRInTerminal: false,
                markOnlineOnConnect: false,
            });

            this.instances.set(instanceId, {
                socket: sock,
                qr: null,
                status: 'connecting',
                userInfo: null,
                saveCreds
            });

            sock.ev.on("connection.update", async (update) => {
                const instance = this.instances.get(instanceId);
                const { qr, connection, lastDisconnect } = update;

                if (qr) {
                    instance.qr = await qrcode.toDataURL(qr);
                    instance.status = 'qr_generated';
                    await this.updateInstanceStatus(instanceId, 'qr_generated');
                }

                if (connection === "open") {
                    instance.status = 'connected';
                    instance.qr = null;
                    instance.userInfo = {
                        id: sock.user.id,
                        name: sock.user.name || "Usuario",
                        phone: sock.user.id.split(':')[0]
                    };

                    await this.updateInstanceStatus(instanceId, 'connected');
                    console.log(`✅ Instancia ${instanceId} conectada correctamente`);
                }

                if (connection === "close") {
                    const statusCode = (lastDisconnect.error)?.output?.statusCode;
                    const manualLogout = statusCode === 401;

                    if (manualLogout) {
                        instance.status = 'disconnected';
                        await this.updateInstanceStatus(instanceId, 'disconnected');
                        return;
                    }

                    // Reconexión automática
                    setTimeout(() => {
                        this.startInstance(instanceId);
                    }, 3000);
                }
            });

            sock.ev.on("creds.update", saveCreds);

            return true;
        } catch (error) {
            console.error(`Error iniciando instancia ${instanceId}:`, error);
            throw error;
        }
    }

    // Actualizar estado de instancia en BD
    async updateInstanceStatus(userToken, instanceId, status) {
        try {
            // Actualizar el estado de la instancia para el usuario específico
            await this.db.run(
                `UPDATE instances 
             SET status = ? 
             WHERE instance_id = ? 
             AND user_id = (SELECT id FROM users WHERE token = ?)`,
                [status, instanceId, userToken]
            );
            console.log(`Estado actualizado a ${status} para ${userToken}_${instanceId}`);
        } catch (error) {
            console.error('Error actualizando estado de instancia:', error);
            throw error;
        }
    }

    // Verificar si token e instancia son válidos
    async validateTokenAndInstance(userToken, instanceId) {
        try {
            const result = await this.db.get(`
        SELECT i.*, u.token 
        FROM instances i 
        JOIN users u ON i.user_id = u.id 
        WHERE u.token = ? AND i.instance_id = ?
      `, userToken, instanceId);

            return !!result;
        } catch (error) {
            console.error('Error validando token e instancia:', error);
            return false;
        }
    }

    // Guardar mensaje en BD
    // async saveMessage(instanceId, fromUser, toUser, message, messageType = 'text') {
    //     try {
    //         const instance = await this.db.get(
    //             'SELECT id FROM instances WHERE instance_id = ?',
    //             instanceId
    //         );

    //         if (!instance) {
    //             throw new Error('Instancia no encontrada');
    //         }

    //         await this.db.run(
    //             `INSERT INTO messages (instance_id, from_user, to_user, message, message_type) 
    //      VALUES (?, ?, ?, ?, ?)`,
    //             instance.id, fromUser, toUser, message, messageType
    //         );

    //         return true;
    //     } catch (error) {
    //         console.error('Error guardando mensaje:', error);
    //         throw error;
    //     }
    // }
    async saveMessage(userToken, instanceId, fromUser, toUser, message, messageType = 'text') {
        try {
            console.log(`💾 Intentando guardar mensaje para: ${userToken}_${instanceId}`);

            // ✅ CORREGIDO: Buscar por instance_id Y userToken
            const instance = await this.db.get(
                `SELECT i.id 
             FROM instances i 
             JOIN users u ON i.user_id = u.id 
             WHERE i.instance_id = ? AND u.token = ?`,
                instanceId, userToken
            );

            if (!instance) {
                console.error(`❌ Instancia no encontrada en BD: ${instanceId} para token: ${userToken}`);
                throw new Error('Instancia no encontrada en la base de datos');
            }

            await this.db.run(
                `INSERT INTO messages (instance_id, from_user, to_user, message, message_type) 
             VALUES (?, ?, ?, ?, ?)`,
                instance.id, fromUser, toUser, message, messageType
            );

            console.log(`✅ Mensaje guardado en BD para instancia: ${instanceId}`);
            return true;
        } catch (error) {
            console.error('❌ Error guardando mensaje:', error);
            throw error;
        }
    }
    getInstanceSocket(userToken, instanceId) {
        if (this.instances.size === 0) {
            console.log(`❌ El mapa de instancias está VACÍO`);
            return;
        }

        this.instances.forEach((value, key) => {
            console.log(`\n   --- INSTANCIA: ${key} ---`);
            console.log(`   - Status: ${value.status}`);
            console.log(`   - Tiene socket: ${!!value.socket}`);
            console.log(`   - Tiene QR: ${!!value.qr}`);
            console.log(`   - UserInfo:`, value.userInfo);
            console.log(`   - SaveCreds: ${!!value.saveCreds}`);
        });
        // ❌ PROBLEMA: Estás usando solo instanceId
        // const instanceKey = `${instanceId}`;

        // ✅ SOLUCIÓN: Usa la misma clave que en startWhatsAppSession
        const instanceKey = `${userToken}_${instanceId}`;

        console.log(`🔍 Buscando socket para la instanceKey: ${instanceKey}`);

        // Mostrar TODAS las instancias disponibles para debug
        console.log(`📊 Instancias disponibles en el mapa:`);
        this.instances.forEach((value, key) => {
            console.log(`   - ${key} -> status: ${value.status}`);
        });

        const instance = this.instances.get(instanceKey);
        console.log(`🔍 Instancia encontrada: ${instance ? 'SÍ ✅' : 'NO ❌'}`);

        return instance ? instance.socket : null;
    }
    async debugUserAndInstances(userToken) {
        try {
            // Verificar si el usuario existe
            const user = await this.db.get('SELECT * FROM users WHERE token = ?', userToken);
            if (!user) {
                console.log(`❌ No se encontró usuario con token: ${userToken}`);
                return null;
            }
            console.log(`✅ Usuario encontrado: ${user.id}, token: ${user.token}`);

            // Verificar instancias del usuario
            const instances = await this.db.all('SELECT * FROM instances WHERE user_id = ?', user.id);
            console.log(`📊 Instancias encontradas para el usuario: ${instances.length}`);
            instances.forEach(instance => {
                console.log(`   - Instancia ID: ${instance.id}, instance_id: ${instance.instance_id}, status: ${instance.status}`);
            });

            // Verificar mensajes para cada instancia
            for (const instance of instances) {
                const messagesCount = await this.db.get(
                    'SELECT COUNT(*) as count FROM messages WHERE instance_id = ?',
                    instance.id
                );
                console.log(`   - Mensajes en instancia ${instance.id}: ${messagesCount.count}`);
            }

            return { user, instances };
        } catch (error) {
            console.error('❌ Error en diagnóstico:', error);
            throw error;
        }
    }
    
    async getUserMessages(userToken, instanceId = null, limit = 50, offset = 0) {
        try {
            console.log(`📨 Obteniendo mensajes para token: ${userToken}, instancia: ${instanceId}`);

            let query = `
    SELECT 
        m.*,
        i.instance_id,
        u.token,
        datetime(m.timestamp) as formatted_date
    FROM messages m
    JOIN instances i ON m.instance_id = i.instance_id
    JOIN users u ON i.user_id = u.id
    WHERE u.token = ?
`;

const params = [userToken];

if (instanceId) {
    query += ` AND i.instance_id = ?`;
    params.push(instanceId);
}

query += ` ORDER BY m.timestamp DESC LIMIT ? OFFSET ?`;
params.push(limit, offset);

const messages = await this.db.all(query, params);


            // Formatear los mensajes para una mejor respuesta
            const formattedMessages = messages.map(msg => ({
                id: msg.id,
                instance_id: msg.instance_id,
                from_user: msg.from_user,
                to_user: msg.to_user,
                message: msg.message,
                message_type: msg.message_type,
                created_at: msg.formatted_date,  // Usamos la fecha formateada
                timestamp: new Date(msg.timestamp).getTime()  // Convertimos el timestamp a número
            }));

            console.log(`✅ Encontrados ${formattedMessages.length} mensajes para ${userToken}`);
            return formattedMessages;

        } catch (error) {
            console.error('❌ Error obteniendo mensajes del usuario:', error);
            throw error;
        }
    }

    // Obtener info de usuario de la instancia
    getInstanceUserInfo(instanceId) {
        const instance = this.instances.get(instanceId);
        return instance ? instance.userInfo : null;
    }
    async getConnectedInstance(userToken) {
        try {
            const instances = await this.db.all(`
      SELECT i.* 
      FROM instances i 
      JOIN users u ON i.user_id = u.id 
      WHERE u.token = ? AND i.status = 'connected'
      ORDER BY i.created_at DESC
      LIMIT 1
    `, userToken);

            if (instances.length > 0) {
                const instance = instances[0];
                const instanceKey = `${userToken}_${instance.instance_id}`;
                const instanceData = this.instances.get(instanceKey);

                return {
                    instance_id: instance.instance_id,
                    status: instance.status,
                    userInfo: instanceData?.userInfo || null
                };
            }
            return null;
        } catch (error) {
            console.error('Error obteniendo instancia conectada:', error);
            return null;
        }
    }

    async getUserInstances(userToken) {
        try {
            const instances = await this.db.all(`
      SELECT i.* 
      FROM instances i 
      JOIN users u ON i.user_id = u.id 
      WHERE u.token = ?
      ORDER BY i.created_at DESC
    `, userToken);

            return instances.map(instance => {
                const instanceKey = `${userToken}_${instance.instance_id}`;
                const instanceData = this.instances.get(instanceKey);

                return {
                    instance_id: instance.instance_id,
                    status: instance.status,
                    userInfo: instanceData?.userInfo || null,
                    created_at: instance.created_at
                };
            });
        } catch (error) {
            console.error('Error obteniendo instancias del usuario:', error);
            return [];
        }
    }

    async startWhatsApp(userToken, instanceId) {
        try {
            // Ruta de la sesión para esta instancia
            const sessionPath = path.join(process.cwd(), 'sessions', userToken, instanceId);

            // Crear directorio si no existe
            await fs.mkdir(sessionPath, { recursive: true });

            const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
            const { version } = await fetchLatestBaileysVersion();

            const sock = makeWASocket({
                version,
                auth: state,
                printQRInTerminal: true, // Para ver el QR en la consola
                markOnlineOnConnect: true,
            });

            // Guardar la instancia en el mapa
            const instanceKey = `${userToken}_${instanceId}`;
            this.instances.set(instanceKey, {
                socket: sock,
                qr: null,
                status: 'connecting',
                userInfo: null,
                saveCreds
            });

            sock.ev.on("connection.update", async (update) => {
                const instance = this.instances.get(instanceKey);
                const { qr, connection, lastDisconnect } = update;

                if (qr) {
                    console.log(`Generando QR para ${instanceKey}`);
                    instance.qr = await qrcode.toDataURL(qr);
                    instance.status = 'qr_generated';
                }

                if (connection === "open") {
                    console.log(`Conexión abierta para ${instanceKey}`);
                    instance.status = 'connected';
                    instance.qr = null;
                    instance.userInfo = {
                        id: sock.user.id,
                        name: sock.user.name || "Usuario",
                        phone: sock.user.id.split(':')[0]
                    };
                }

                if (connection === "close") {
                    const statusCode = (lastDisconnect.error)?.output?.statusCode;
                    const manualLogout = statusCode === 401;

                    if (manualLogout) {
                        instance.status = 'disconnected';
                        return;
                    }

                    // Reconexión automática
                    setTimeout(() => {
                        this.startWhatsApp(userToken, instanceId);
                    }, 3000);
                }
            });

            sock.ev.on("creds.update", saveCreds);

        } catch (error) {
            console.error(`Error en startWhatsApp para ${userToken}_${instanceId}:`, error);
            throw error;
        }
    }

    // Iniciar una sesión de WhatsApp y generar QR
    async startWhatsAppSession(userToken, instanceId) {
        try {
            // Ruta de la sesión
            const sessionPath = path.join(__dirname, 'sessions', userToken, instanceId);
            await fs.mkdir(path.dirname(sessionPath), { recursive: true });

            const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
            const { version } = await fetchLatestBaileysVersion();

            const sock = makeWASocket({
                version,
                auth: state,
                markOnlineOnConnect: true,
                // printQRInTerminal: true, // Descomenta si quieres ver el QR en la terminal
            });

            const instanceKey = `${userToken}_${instanceId}`;

            // Guardar en el mapa
            this.instances.set(instanceKey, {
                socket: sock,
                qr: null,
                status: 'connecting',
                userInfo: null,
                saveCreds
            });

            // Retornar una promesa que se resuelve cuando se genera el QR
            return new Promise((resolve, reject) => {
                sock.ev.on("connection.update", async (update) => {
                    const instance = this.instances.get(instanceKey);
                    const { qr, connection, lastDisconnect } = update;

                    if (qr) {
                        console.log(`Generando QR para ${instanceKey}`);
                        instance.qr = await qrcode.toDataURL(qr);
                        instance.status = 'qr_generated';
                        // Resolvemos la promesa con el QR
                        resolve({
                            qr: instance.qr,
                            instanceId: instanceId
                        });
                    }

                    if (connection === "open") {
                        console.log(`Conexión abierta para ${instanceKey}`);
                        instance.status = 'connected';
                        instance.qr = null;
                        instance.userInfo = {
                            id: sock.user.id,
                            name: sock.user.name || "Usuario",
                            phone: sock.user.id.split(':')[0]
                        };

                        // Guardar la instancia en la BD solo cuando se conecta
                        await this.saveInstanceToDB(userToken, instanceId, instance.userInfo);
                    }

                    if (connection === "close") {
                        const statusCode = (lastDisconnect.error)?.output?.statusCode;
                        const manualLogout = statusCode === 401;

                        if (manualLogout) {
                            instance.status = 'disconnected';
                            // Actualizar BD a disconnected
                            await this.updateInstanceStatusInDB(userToken, instanceId, 'disconnected');
                            return;
                        }

                        // Reconexión automática
                        setTimeout(() => {
                            this.startWhatsAppSession(userToken, instanceId);
                        }, 3000);
                    }
                });

                sock.ev.on("creds.update", saveCreds);
            });

        } catch (error) {
            console.error(`Error en startWhatsAppSession para ${userToken}_${instanceId}:`, error);
            throw error;
        }
    }
    // async startWhatsAppSession(userToken, instanceId) {
    //     try {
    //         const instanceKey = `${userToken}_${instanceId}`;
    //         console.log(`\n🚀 [startWhatsAppSession] INICIANDO para: ${instanceKey}`);

    //         // ⚠️ PRIMERO: Limpiar cualquier instancia previa con la misma key
    //         if (this.instances.has(instanceKey)) {
    //             console.log(`🔄 Instancia previa encontrada, limpiando...`);
    //             const oldInstance = this.instances.get(instanceKey);
    //             if (oldInstance && oldInstance.socket) {
    //                 try {
    //                     oldInstance.socket.ev.removeAllListeners();
    //                     await oldInstance.socket.end();
    //                 } catch (error) {
    //                     console.log('Error limpiando instancia previa:', error.message);
    //                 }
    //             }
    //             this.instances.delete(instanceKey);
    //         }

    //         // Ruta de la sesión
    //         const sessionPath = path.join(__dirname, 'sessions', userToken, instanceId);
    //         await fs.mkdir(path.dirname(sessionPath), { recursive: true });

    //         console.log(`📁 Session path: ${sessionPath}`);

    //         const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    //         const { version } = await fetchLatestBaileysVersion();

    //         const sock = makeWASocket({
    //             version,
    //             auth: state,
    //             markOnlineOnConnect: true,
    //             printQRInTerminal: true,
    //         });

    //         // ✅ CREAR NUEVA INSTANCIA
    //         const instanceData = {
    //             socket: sock,
    //             qr: null,
    //             status: 'connecting',
    //             userInfo: null,
    //             saveCreds
    //         };

    //         // ✅ GUARDAR EN MAPA INMEDIATAMENTE
    //         this.instances.set(instanceKey, instanceData);

    //         // ✅ VERIFICACIÓN INMEDIATA
    //         console.log(`💾 [startWhatsAppSession] Instancia guardada en mapa: ${instanceKey}`);
    //         console.log(`📊 [startWhatsAppSession] Total instancias en mapa: ${this.instances.size}`);

    //         const savedInstance = this.instances.get(instanceKey);
    //         console.log(`🔍 [startWhatsAppSession] Verificación: instancia guardada correctamente: ${!!savedInstance}`);

    //         // Retornar una promesa que se resuelve cuando se genera el QR
    //         return new Promise((resolve, reject) => {
    //             let qrGenerated = false;

    //             sock.ev.on("connection.update", async (update) => {
    //                 const currentInstance = this.instances.get(instanceKey);
    //                 if (!currentInstance) {
    //                     console.log(`❌ ERROR: Instancia ${instanceKey} no encontrada durante conexión`);
    //                     return;
    //                 }

    //                 const { qr, connection, lastDisconnect } = update;

    //                 console.log(`🔄 [connection.update] Para ${instanceKey}: ${connection}`);

    //                 if (qr) {
    //                     console.log(`📱 QR generado para ${instanceKey}`);
    //                     currentInstance.qr = await qrcode.toDataURL(qr);
    //                     currentInstance.status = 'qr_generated';
    //                     qrGenerated = true;

    //                     resolve({
    //                         qr: currentInstance.qr,
    //                         instanceId: instanceId,
    //                         status: 'qr_generated'
    //                     });
    //                 }

    //                 if (connection === "open") {
    //                     console.log(`✅ CONEXIÓN ABIERTA para ${instanceKey}`);
    //                     currentInstance.status = 'connected';
    //                     currentInstance.qr = null;
    //                     currentInstance.userInfo = {
    //                         id: sock.user.id,
    //                         name: sock.user.name || "Usuario",
    //                         phone: sock.user.id.split(':')[0]
    //                     };

    //                     console.log(`👤 User info: ${currentInstance.userInfo.phone}`);

    //                     // Guardar en BD
    //                     await this.saveInstanceToDB(userToken, instanceId, currentInstance.userInfo);

    //                     // Verificación final
    //                     console.log(`🔍 [startWhatsAppSession] Verificación final - Instancia ${instanceKey} conectada correctamente`);
    //                 }

    //                 if (connection === "close") {
    //                     console.log(`🔌 Conexión cerrada para ${instanceKey}`);
    //                     const statusCode = (lastDisconnect.error)?.output?.statusCode;

    //                     if (statusCode === 401) {
    //                         console.log(`👤 Logout manual detectado`);
    //                         currentInstance.status = 'disconnected';
    //                         await this.updateInstanceStatusInDB(userToken, instanceId, 'disconnected');
    //                         return;
    //                     }

    //                     // Reconexión automática
    //                     console.log(`🔄 Reconectando en 3 segundos...`);
    //                     setTimeout(() => {
    //                         this.startWhatsAppSession(userToken, instanceId);
    //                     }, 3000);
    //                 }
    //             });

    //             sock.ev.on("creds.update", saveCreds);

    //             // Timeout para evitar promesas colgadas
    //             setTimeout(() => {
    //                 if (!qrGenerated) {
    //                     reject(new Error("Timeout al generar QR"));
    //                 }
    //             }, 30000);
    //         });

    //     } catch (error) {
    //         console.error(`❌ Error en startWhatsAppSession para ${userToken}_${instanceId}:`, error);
    //         throw error;
    //     }
    // }
    // Guardar instancia en la BD cuando se conecta
    async saveInstanceToDB(userToken, instanceId, userInfo) {
        try {
            // Asegurarnos de que el usuario existe
            await this.createUser(userToken);

            const user = await this.db.get('SELECT * FROM users WHERE token = ?', userToken);
            // Insertar o actualizar la instancia
            await this.db.run(
                `INSERT OR REPLACE INTO instances (user_id, instance_id, status) 
                 VALUES (?, ?, ?)`,
                user.id, instanceId, 'connected'
            );

            console.log(`Instancia guardada en BD: ${instanceId} para ${userToken}`);
        } catch (error) {
            console.error('Error guardando instancia en BD:', error);
        }
    }

    async updateInstanceStatusInDB(userToken, instanceId, status) {
        try {
            await this.db.run(
                `UPDATE instances SET status = ? 
             WHERE instance_id = ? AND user_id = (SELECT id FROM users WHERE token = ?)`,
                status, instanceId, userToken
            );
        } catch (error) {
            console.error('Error actualizando estado de instancia:', error);
            throw error;
        }
    }

    // Obtener QR de una instancia activa
    getInstanceQR(userToken, instanceId) {
        const instanceKey = `${userToken}_${instanceId}`;
        const instance = this.instances.get(instanceKey);
        return instance ? instance.qr : null;
    }

    // Obtener estado de una instancia activa
    getInstanceStatus(userToken, instanceId) {
        const instanceKey = `${userToken}_${instanceId}`;
        const instance = this.instances.get(instanceKey);
        return instance ? instance.status : 'not_found';
    }
    async disconnectInstance(userToken, instanceId) {
        try {
            const instanceKey = `${userToken}_${instanceId}`;
            const instanceData = this.instances.get(instanceKey);

            if (instanceData && instanceData.socket) {
                instanceData.socket.ev.removeAllListeners();
                try {
                    await instanceData.socket.logout();
                } catch (error) {
                    await instanceData.socket.end();
                }
            }

            this.instances.delete(instanceKey);

            // Actualizar estado en BD
            await this.updateInstanceStatus(userToken, instanceId, 'disconnected');

            // Eliminar sesión
            const sessionPath = path.join(__dirname, 'sessions', userToken, instanceId);
            try {
                await fs.rm(sessionPath, { recursive: true, force: true });
            } catch (error) {
                console.log('No se pudo eliminar sesión:', error.message);
            }

            return true;
        } catch (error) {
            console.error('Error desconectando instancia:', error);
            throw error;
        }
    }
}