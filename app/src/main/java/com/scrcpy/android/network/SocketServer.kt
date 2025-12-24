package com.scrcpy.android.network

import kotlinx.coroutines.*
import java.net.ServerSocket
import java.net.Socket

class SocketServer(private val port: Int) {
    
    private var serverSocket: ServerSocket? = null
    private var isRunning = false
    private val scope = CoroutineScope(Dispatchers.IO + Job())

    fun start(onClientConnected: (Socket) -> Unit) {
        scope.launch {
            try {
                isRunning = true
                serverSocket = ServerSocket(port)
                
                while (isRunning) {
                    val clientSocket = serverSocket?.accept()
                    clientSocket?.let {
                        onClientConnected(it)
                    }
                }
            } catch (e: Exception) {
                e.printStackTrace()
            }
        }
    }

    fun stop() {
        isRunning = false
        try {
            serverSocket?.close()
        } catch (e: Exception) {
            e.printStackTrace()
        }
        scope.cancel()
    }
}
