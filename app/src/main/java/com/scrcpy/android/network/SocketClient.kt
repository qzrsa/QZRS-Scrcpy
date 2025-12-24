package com.scrcpy.android.network

import kotlinx.coroutines.*
import java.io.InputStream
import java.net.Socket

class SocketClient(private val host: String, private val port: Int) {
    
    private var socket: Socket? = null
    private var inputStream: InputStream? = null
    private val scope = CoroutineScope(Dispatchers.IO + Job())

    suspend fun connect(): Boolean = withContext(Dispatchers.IO) {
        try {
            socket = Socket(host, port)
            inputStream = socket?.getInputStream()
            true
        } catch (e: Exception) {
            e.printStackTrace()
            false
        }
    }

    fun readData(buffer: ByteArray): Int {
        return try {
            inputStream?.read(buffer) ?: -1
        } catch (e: Exception) {
            e.printStackTrace()
            -1
        }
    }

    fun disconnect() {
        try {
            inputStream?.close()
            socket?.close()
        } catch (e: Exception) {
            e.printStackTrace()
        }
        scope.cancel()
    }
}
