package com.scrcpy.android

import android.app.*
import android.content.Intent
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.scrcpy.android.network.SocketServer
import com.scrcpy.android.video.ScreenEncoder
import kotlinx.coroutines.*

class ServerService : Service() {
    
    private var mediaProjection: MediaProjection? = null
    private var screenEncoder: ScreenEncoder? = null
    private var socketServer: SocketServer? = null
    private val serviceScope = CoroutineScope(Dispatchers.Default + Job())
    
    companion object {
        private const val NOTIFICATION_ID = 1
        private const val CHANNEL_ID = "scrcpy_channel"
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification = createNotification()
        startForeground(NOTIFICATION_ID, notification)
        
        intent?.let {
            val resultCode = it.getIntExtra("resultCode", 0)
            val data = it.getParcelableExtra<Intent>("data")
            val port = it.getIntExtra("port", 5555)
            
            if (data != null) {
                startScreenSharing(resultCode, data, port)
            }
        }
        
        return START_STICKY
    }

    private fun startScreenSharing(resultCode: Int, data: Intent, port: Int) {
        serviceScope.launch {
            try {
                // 获取 MediaProjection
                val projectionManager = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
                mediaProjection = projectionManager.getMediaProjection(resultCode, data)
                
                // 启动Socket服务器
                socketServer = SocketServer(port)
                socketServer?.start { socket ->
                    // 客户端连接后，开始编码和发送视频流
                    screenEncoder = ScreenEncoder(mediaProjection!!, socket)
                    screenEncoder?.start()
                }
                
            } catch (e: Exception) {
                e.printStackTrace()
                stopSelf()
            }
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "屏幕共享服务",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "用于屏幕投屏的前台服务"
            }
            
            val notificationManager = getSystemService(NotificationManager::class.java)
            notificationManager.createNotificationChannel(channel)
        }
    }

    private fun createNotification(): Notification {
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("屏幕共享中")
            .setContentText("其他设备可以查看您的屏幕")
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    override fun onDestroy() {
        super.onDestroy()
        screenEncoder?.stop()
        socketServer?.stop()
        mediaProjection?.stop()
        serviceScope.cancel()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
