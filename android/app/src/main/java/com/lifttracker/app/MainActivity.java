package com.lifttracker.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register our local self-update plugin before the bridge initializes.
        registerPlugin(UpdaterPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
