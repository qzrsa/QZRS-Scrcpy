package com.scrcpy.android

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat

class MainActivity : AppCompatActivity() {
    
    private lateinit var ipInput: EditText
    private lateinit var portInput: EditText
    private lateinit var connectBtn: Button
    private lateinit var startServerBtn: Button
    
    companion object {
        private const val REQUEST_MEDIA_PROJECTION = 1001
        private const val REQUEST_NOTIFICATION_PERMISSION = 1002
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        
        ipInput = findViewById(R.id.ipInput)
        portInput = findViewById(R.id.portInput)
        connectBtn = findViewById(R.id.connectBtn)
        startServerBtn = findViewById(R.id.startServerBtn)
        
        // 默认端口
        portInput.setText("5555")
        
        // 连接到远程设备（作为控制端）
        connectBtn.setOnClickListener {
            val ip = ipInput.text.toString()
            val port = portInput.text.toString().toIntOrNull() ?: 5555
            
            if (ip.isNotEmpty()) {
                val intent = Intent(this, ControllerActivity::class.java).apply {
                    putExtra("ip", ip)
                    putExtra("port", port)
                }
                startActivity(intent)
            } else {
                Toast.makeText(this, "请输入IP地址", Toast.LENGTH_SHORT).show()
            }
        }
        
        // 启动服务（作为被控端）
        startServerBtn.setOnClickListener {
            requestNotificationPermission()
        }
    }
    
    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ActivityCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(
                    this,
                    arrayOf(Manifest.permission.POST_NOTIFICATIONS),
                    REQUEST_NOTIFICATION_PERMISSION
                )
            } else {
                requestMediaProjection()
            }
        } else {
            requestMediaProjection()
        }
    }
    
    private fun requestMediaProjection() {
        val projectionManager = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        startActivityForResult(projectionManager.createScreenCaptureIntent(), REQUEST_MEDIA_PROJECTION)
    }
    
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        
        if (requestCode == REQUEST_MEDIA_PROJECTION && resultCode == RESULT_OK && data != null) {
            val port = portInput.text.toString().toIntOrNull() ?: 5555
            val intent = Intent(this, ServerService::class.java).apply {
                putExtra("resultCode", resultCode)
                putExtra("data", data)
                putExtra("port", port)
            }
            
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(intent)
            } else {
                startService(intent)
            }
            
            Toast.makeText(this, "服务已启动，端口: $port", Toast.LENGTH_LONG).show()
        }
    }
    
    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        
        if (requestCode == REQUEST_NOTIFICATION_PERMISSION) {
            if (grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                requestMediaProjection()
            }
        }
    }
}
