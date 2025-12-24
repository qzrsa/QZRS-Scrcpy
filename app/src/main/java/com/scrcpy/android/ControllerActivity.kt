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
        
        // 保持屏幕常亮
        window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        
        surfaceView = findViewById(R.id.surfaceView)
        
        val ip = intent.getStringExtra("ip") ?: ""
        val port = intent.getIntExtra("port", 5555)
        
        Log.d(TAG, "Controller started, will connect to $ip:$port")
        Toast.makeText(this, "正在连接到 $ip:$port...", Toast.LENGTH_SHORT).show()
        
        surfaceView.holder.addCallback(object : SurfaceHolder.Callback {
            override fun surfaceCreated(holder: SurfaceHolder) {
                Log.d(TAG, "Surface created")
                connectToDevice(ip, port, holder.surface)
            }

            override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
                Log.d(TAG, "Surface changed: ${width}x${height}, format=$format")
            }
            
            override fun surfaceDestroyed(holder: SurfaceHolder) {
                Log.d(TAG, "Surface destroyed")
                disconnect()
            }
        })
    }

    private fun connectToDevice(ip: String, port: Int, surface: android.view.Surface) {
        scope.launch {
            try {
                socketClient = SocketClient(ip, port)
                
                val connected = withContext(Dispatchers.IO) {
                    socketClient?.connect()
                }
                
                if (connected == true) {
                    runOnUiThread {
                        Toast.makeText(
                            this@ControllerActivity,
                            "连接成功，开始接收视频...",
                            Toast.LENGTH_SHORT
                        ).show()
                    }
                    
                    Log.d(TAG, "Connection successful, starting decoder...")
                    videoDecoder = VideoDecoder(socketClient!!, surface)
                    videoDecoder?.start()
                    
                } else {
                    runOnUiThread {
                        Toast.makeText(
                            this@ControllerActivity,
                            "连接失败：无法连接到 $ip:$port\n请检查：\n1. IP地址是否正确\n2. 被控设备是否已启动服务\n3. 两台设备是否在同一WiFi",
                            Toast.LENGTH_LONG
                        ).show()
                    }
                    Log.e(TAG, "Connection failed")
                    finish()
                }
            } catch (e: Exception) {
                Log.e(TAG, "Connection error", e)
                runOnUiThread {
                    Toast.makeText(
                        this@ControllerActivity,
                        "连接错误: ${e.message}",
                        Toast.LENGTH_LONG
                    ).show()
                    finish()
                }
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
