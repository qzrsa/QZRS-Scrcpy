package com.scrcpy.android

import android.os.Bundle
import android.view.MotionEvent
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

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_controller)
        
        surfaceView = findViewById(R.id.surfaceView)
        
        val ip = intent.getStringExtra("ip") ?: ""
        val port = intent.getIntExtra("port", 5555)
        
        surfaceView.holder.addCallback(object : SurfaceHolder.Callback {
            override fun surfaceCreated(holder: SurfaceHolder) {
                connectToDevice(ip, port, holder.surface)
            }

            override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {}
            override fun surfaceDestroyed(holder: SurfaceHolder) {
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
                Toast.makeText(this@ControllerActivity, "已连接", Toast.LENGTH_SHORT).show()
                videoDecoder = VideoDecoder(socketClient!!, surface)
                videoDecoder?.start()
            } else {
                Toast.makeText(this@ControllerActivity, "连接失败", Toast.LENGTH_SHORT).show()
                finish()
            }
        }
    }

    private fun disconnect() {
        videoDecoder?.stop()
        socketClient?.disconnect()
        scope.cancel()
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        // 这里可以实现触摸事件的发送
        // 需要额外的协议来传输控制指令
        return super.onTouchEvent(event)
    }

    override fun onDestroy() {
        super.onDestroy()
        disconnect()
    }
}
