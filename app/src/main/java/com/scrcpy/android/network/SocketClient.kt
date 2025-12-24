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
            socket = Socket(host, port).apply {
                tcpNoDelay = true
                keepAlive = true
                soTimeout = 5000
            }
            inputStream = socket?.getInputStream()
            Log.d(TAG, "Connected successfully")
            true
        } catch (e: Exception) {
            Log.e(TAG, "Connection failed", e)
            false
        }
    }

    fun getInputStream(): InputStream {
        return inputStream ?: throw IllegalStateException("Not connected")
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
