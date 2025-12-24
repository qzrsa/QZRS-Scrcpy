package com.scrcpy.android.network

import android.util.Log
import kotlinx.coroutines.*
import java.io.InputStream
import java.net.Socket

class SocketClient(private val host: String, private val port: Int) {
    
    private var socket: Socket? = null
    private var inputStream: InputStream? = null
    private val scope = CoroutineScope(Dispatchers.IO + Job())

    companion object {
        private const val TAG = "SocketClient"
    }

    suspend fun connect(): Boolean = withContext(Dispatchers.IO) {
        try {
            Log.d(TAG, "Connecting to $host:$port...")
            socket = Socket(host, port)
            socket?.tcpNoDelay = true
            socket?.keepAlive = true
            inputStream = socket?.getInputStream()
            Log.d(TAG, "Connected successfully")
            true
        } catch (e: Exception) {
            Log.e(TAG, "Connection failed", e)
            false
        }
    }

    fun readData(buffer: ByteArray, offset: Int = 0, length: Int = buffer.size): Int {
        return try {
            inputStream?.read(buffer, offset, length) ?: -1
        } catch (e: Exception) {
            Log.e(TAG, "Read error", e)
            -1
        }
    }

    fun disconnect() {
        try {
            inputStream?.close()
            socket?.close()
            Log.d(TAG, "Disconnected")
        } catch (e: Exception) {
            Log.e(TAG, "Disconnect error", e)
        }
        scope.cancel()
    }
}
