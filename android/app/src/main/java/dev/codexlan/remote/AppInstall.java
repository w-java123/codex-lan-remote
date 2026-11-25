package dev.codexlan.remote;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.os.Build;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.Arrays;
import java.util.HashSet;
import org.json.JSONObject;

/** Owns a single self-update, including callbacks across replacement of this process. */
public final class AppInstall extends BroadcastReceiver {
    private static final String ACTION="dev.codexlan.remote.INSTALL_RESULT";
    private static final int NOTICE=19;
    private static final String CHANNEL="app_updates";
    private static boolean preparing;
    private static volatile Intent confirmation;
    private static volatile String stage="";
    private static volatile int percent=-1;

    static SharedPreferences state(Context context) {
        return context.getSharedPreferences("appInstall",Context.MODE_PRIVATE);
    }

    static String progress(Context context) {
        if(!stage.isEmpty())return stage;
        return state(context).getString("message","");
    }

    static int percent() { return percent; }

    static synchronized boolean active(Context context) {
        SharedPreferences saved=state(context);
        int id=saved.getInt("session",-1);
        if(preparing)return true;
        if(id<0)return false;
        if(context.getPackageManager().getPackageInstaller().getSessionInfo(id)!=null)return true;
        // A final callback can arrive immediately after the system removes the session.
        if(System.currentTimeMillis()-saved.getLong("submittedAt",0)<15000)return true;
        boolean updated=isInstalled(context,saved.getString("target",""));
        saved.edit().remove("session").remove("confirmation").putString("message",updated?"更新完成":"安装会话已结束，请重新更新").apply();
        return false;
    }

    static synchronized Intent takeConfirmation() {
        Intent intent=confirmation;
        confirmation=null;
        return intent;
    }

    static synchronized void cancelPending(Context context) {
        SharedPreferences saved=state(context);
        if(!saved.getBoolean("confirmation",false))return;
        int session=saved.getInt("session",-1);
        if(session>=0)try{context.getPackageManager().getPackageInstaller().abandonSession(session);}catch(RuntimeException ignored){}
        saved.edit().remove("session").remove("confirmation").putString("message","更新可重新提交").apply();
        NotificationManager manager=context.getSystemService(NotificationManager.class);
        if(manager!=null)manager.cancel(NOTICE);
    }

    static boolean needsConfirmation(Context context) { return state(context).getBoolean("confirmation",false); }

    static boolean isInstalled(Context context,String target) {
        try {
            String current=context.getPackageManager().getPackageInfo(context.getPackageName(),0).versionName;
            return UpdatePolicy.numbers(target)!=null&&UpdatePolicy.compare(current,target)>=0;
        } catch(Exception unavailable){return false;}
    }

    static void start(Context source,JSONObject release) {
        Context context=source.getApplicationContext();
        synchronized(AppInstall.class){
            if(active(context))return;
            preparing=true;
            stage="正在检查可用更新…";
            percent=-1;
        }
        new Thread(()->apply(context,release),"APK update").start();
    }

    private static void apply(Context context,JSONObject release) {
        PackageInstaller installer=context.getPackageManager().getPackageInstaller();
        SharedPreferences saved=state(context);
        String target=release.optString("androidVersion");
        int id=-1;
        File apk=null;
        try {
            apk=ApkUpdateDownload.prepare(context,release,(message,value)->{stage=message;percent=value;});
            validate(context,apk,target);
            stage="正在提交给 Android 安装…";
            percent=-1;
            PackageInstaller.SessionParams params=new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
            params.setAppPackageName(context.getPackageName());
            params.setSize(apk.length());
            if(Build.VERSION.SDK_INT>=31)params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
            id=installer.createSession(params);
            try(PackageInstaller.Session session=installer.openSession(id)){
                try(FileInputStream input=new FileInputStream(apk); OutputStream output=session.openWrite("base.apk",0,apk.length())){
                    byte[] buffer=new byte[65536];int count;
                    while((count=input.read(buffer))!=-1)output.write(buffer,0,count);
                    session.fsync(output);
                }
                Intent result=new Intent(context,AppInstall.class).setAction(ACTION);
                int flags=PendingIntent.FLAG_UPDATE_CURRENT;
                if(Build.VERSION.SDK_INT>=31)flags|=PendingIntent.FLAG_MUTABLE;
                PendingIntent callback=PendingIntent.getBroadcast(context,id,result,flags);
                if(!saved.edit().putInt("session",id).putString("target",target)
                        .putLong("submittedAt",System.currentTimeMillis()).remove("confirmation")
                        .putString("message","Android 正在安装更新…").commit())throw new IOException("无法保存更新状态");
                session.commit(callback.getIntentSender());
            }
        } catch(Exception error){
            if(id>=0)try{installer.abandonSession(id);}catch(RuntimeException ignored){}
            String detail=error instanceof IOException?error.getMessage():"请检查安装权限或存储空间";
            saved.edit().remove("session").remove("target").remove("confirmation").putString("message","更新失败 · "+detail).apply();
        } finally {
            if(apk!=null)apk.delete();
            synchronized(AppInstall.class){preparing=false;stage="";percent=-1;}
        }
    }

    private static void validate(Context context,File apk,String target)throws Exception{
        PackageManager manager=context.getPackageManager();
        PackageInfo installed=manager.getPackageInfo(context.getPackageName(),PackageManager.GET_SIGNING_CERTIFICATES);
        PackageInfo update=manager.getPackageArchiveInfo(apk.getPath(),PackageManager.GET_SIGNING_CERTIFICATES);
        if(update==null||!installed.packageName.equals(update.packageName)||update.getLongVersionCode()<=installed.getLongVersionCode()||
                update.versionName==null||UpdatePolicy.compare(target,update.versionName)!=0||UpdatePolicy.numbers(target)==null)
            throw new IOException("安装包的应用或版本与更新不符");
        Signature[] current=installed.signingInfo==null?null:installed.signingInfo.getApkContentsSigners();
        Signature[] next=update.signingInfo==null?null:update.signingInfo.getApkContentsSigners();
        if(current==null||current.length==0||next==null||!new HashSet<>(Arrays.asList(current)).equals(new HashSet<>(Arrays.asList(next))))
            throw new IOException("更新包签名与已安装版本不一致");
    }

    @Override public void onReceive(Context context,Intent result){
        if(!ACTION.equals(result.getAction())||!result.hasExtra(PackageInstaller.EXTRA_STATUS))return;
        SharedPreferences saved=state(context);
        int id=saved.getInt("session",-1);
        if(id<0||id!=result.getIntExtra(PackageInstaller.EXTRA_SESSION_ID,-1))return;
        int status=result.getIntExtra(PackageInstaller.EXTRA_STATUS,PackageInstaller.STATUS_FAILURE);
        if(status==PackageInstaller.STATUS_PENDING_USER_ACTION){
            Intent action=Build.VERSION.SDK_INT>=33?result.getParcelableExtra(Intent.EXTRA_INTENT,Intent.class):result.getParcelableExtra(Intent.EXTRA_INTENT);
            if(action!=null){
                confirmation=action;
                saved.edit().putBoolean("confirmation",true).putString("message","系统需要确认更新").apply();
                notify(context,"更新等待确认",action);
                return;
            }
            try{context.getPackageManager().getPackageInstaller().abandonSession(id);}catch(RuntimeException ignored){}
        }
        confirmation=null;
        String message=status==PackageInstaller.STATUS_SUCCESS?"更新完成，可以打开新版":
            status==PackageInstaller.STATUS_FAILURE_ABORTED?"更新已取消":"Android 未能安装更新，请重试";
        saved.edit().remove("session").remove("confirmation").putString("message",message).apply();
        NotificationManager manager=context.getSystemService(NotificationManager.class);
        if(manager!=null)manager.cancel(NOTICE);
        if(status==PackageInstaller.STATUS_SUCCESS)notify(context,message,
            context.getPackageManager().getLaunchIntentForPackage(context.getPackageName()));
    }

    private static void notify(Context context,String message,Intent action){
        if(action==null)return;
        try{
            NotificationManager manager=context.getSystemService(NotificationManager.class);
            if(manager==null||!manager.areNotificationsEnabled())return;
            manager.createNotificationChannel(new NotificationChannel(CHANNEL,"应用更新",NotificationManager.IMPORTANCE_DEFAULT));
            PendingIntent open=PendingIntent.getActivity(context,NOTICE,action,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
            manager.notify(NOTICE,new Notification.Builder(context,CHANNEL).setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setContentTitle("Codex LAN").setContentText(message).setAutoCancel(true).setContentIntent(open).build());
        }catch(RuntimeException ignored){}
    }
}
