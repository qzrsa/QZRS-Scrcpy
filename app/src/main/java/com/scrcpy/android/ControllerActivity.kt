package com.scrcpy.android

import android.os.Bundle
import android.util.Log
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.scrcpy.android.network.SocketClient
import com.scrcpy.android.video.VideoDecoder
import kotlinx.coroutines.*

class ControllerActivity : AppCompatActivity() {
    
    private lateinit var surfaceView: SurfaceView
    private var socketClient: SocketClient? = null
    private var videoDecoder: VideoDecoder? = null
    private val scope = CoroutineScope(Dispatchers.Main + Job())

    companion object {
        private const val TAG = "ControllerActivity"
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_controller)
        
        surfaceView = findViewById(R.id.surfaceView)
        
        val ip = intent.getStringExtra("ip") ?: ""
        val port = intent.getIntExtra("port", 5555)
        
        Log.d(TAG, "Controller started, connecting to $ip:$port")
        
        surfaceView.holder.addCallback(object : SurfaceHolder.Callback {
            override fun surfaceCreated(holder: SurfaceHolder) {
                Log.d(TAG, "Surface created")
                connectToDevice(ip, port, holder.surface)
            }

            override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
                Log.d(TAG, "Surface changed: ${width}x${height}")
            }
            
            override fun surfaceDestroyed(holder: SurfaceHolder) {
                Log.d(TAG, "Surface destroyed")
                disconnect()
            }
        })
    }

    private fun connectToDevice(ip: String, port: Int, surface: android.view.Surface) {
        scope.launch {
            socketClient = SocketClient(ip, port)
            
            val connected = withContext(Dispatchers.IO) {
                socketClient?.connect()
            }
            
            if (connected == true) {
                Toast.makeText(this@ControllerActivity, "已连接到 $ip:$port", Toast.LENGTH_SHORT).show()
                Log.d(TAG, "Starting video decoder...")
                videoDecoder = VideoDecoder(socketClient!!, surface)
                videoDecoder?.start()
            } else {
                Toast.makeText(this@ControllerActivity, "连接失败，请检查IP和端口", Toast.LENGTH_LONG).show()
                Log.e(TAG, "Connection failed")
                finish()
            }
        }
    }

    private fun disconnect() {
        videoDecoder?.stop()
        socketClient?.disconnect()
        scope.cancel()
    }

    override fun onDestroy() {
        super.onDestroy()
        disconnect()
        Log.d(TAG, "Controller destroyed")
    }
}
